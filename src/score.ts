import { z } from "zod";
import { loadMaster, loadSettings, type Settings } from "./config.js";
import { db, setStatus, type JobRow } from "./db.js";
import { structured } from "./llm.js";

const Score = z.object({
  score: z.number().int().describe("0-100: realistic chance this candidate gets an interview AND would want the job"),
  track: z.string().describe("Which of the candidate's target tracks this role fits best"),
  why: z.array(z.string()).describe("Up to 3 short reasons for the score, most important first"),
  gaps: z.array(z.string()).describe("Hard requirements the candidate clearly lacks"),
  dealbreaker: z.string().nullable().describe("A disqualifying issue (wrong country, needs sponsorship-only visa, 5+ years required, etc.) or null"),
});
export type ScoreResult = z.infer<typeof Score>;

function systemPrompt(s: Settings, master: string) {
  return `You screen job ads for one candidate and estimate fit. Be calibrated and blunt: most ads should score below 60.

Scoring guide:
- 85-100: candidate meets nearly every requirement and the level matches. Apply today.
- 70-84: solid match with one or two gaps a strong CV and cover letter can cover.
- 50-69: stretch: several gaps or a level mismatch.
- below 50: wrong level, wrong field, wrong location, or hard requirements missing.

${s.candidate.background ? `About the candidate: ${s.candidate.background}` : ""} Roles that need clearly more experience than the profile shows, "senior", or management experience score below 50.
The candidate is based in ${s.candidate.location}${s.candidate.location_preference ? ` and wants ${s.candidate.location_preference}` : ""}. Roles in places they can't work from, or remote roles restricted to other countries, are dealbreakers.
Tracks: ${s.targets.map((t) => `"${t.track}" (${t.titles.slice(0, 4).join(", ")}…)`).join("; ")}.

<candidate_profile>
${master}
</candidate_profile>`;
}

export async function scoreJob(job: JobRow, s = loadSettings(), master = loadMaster()): Promise<ScoreResult> {
  return structured({
    model: s.models.scoring,
    effort: "low",
    maxTokens: 8000,
    system: systemPrompt(s, master),
    user: `<job>
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Salary: ${job.salary ?? "not stated"}
Description:
${job.description.slice(0, 12000) || "(no description available — judge from title and company)"}
</job>`,
    schema: Score,
  });
}

export async function scoreNew(log: (m: string) => void = console.log, limit = 60) {
  const s = loadSettings();
  const master = loadMaster();
  // Aggregator jobs wait (up to a day) for their full description before being scored.
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'new'
       AND (enriched = 1 OR source NOT IN ('linkedin', 'reed') OR found_at < datetime('now', '-1 day'))
       ORDER BY (ats IN ('greenhouse','lever','ashby','workable')) DESC, found_at DESC LIMIT ?`,
    )
    .all(limit) as JobRow[];
  const save = db.prepare("UPDATE jobs SET score = ?, track = ?, score_json = ?, status = ?, updated_at = datetime('now') WHERE id = ?");
  let shortlisted = 0;
  // Small concurrency: fast enough, gentle on rate limits.
  const queue = [...rows];
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          const r = await scoreJob(job, s, master);
          const score = r.dealbreaker ? Math.min(r.score, 40) : r.score;
          const status = score >= s.pipeline.min_score ? "shortlisted" : "low";
          if (status === "shortlisted") shortlisted++;
          save.run(score, r.track, JSON.stringify(r), status, job.id);
          log(`${score} ${job.title} @ ${job.company}`);
        } catch (e) {
          setStatus(job.id, "new", `score: ${(e as Error).message}`);
          log(`score failed for ${job.id}: ${(e as Error).message}`);
        }
      }
    }),
  );
  return { scored: rows.length, shortlisted };
}
