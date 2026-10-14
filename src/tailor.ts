import { z } from "zod";
import { loadMaster, loadMasterRaw, loadSettings, type Settings } from "./config.js";
import type { JobRow } from "./db.js";
import { structured } from "./llm.js";

export const Cv = z.object({
  headline: z.string().describe("Role-aligned headline under the name, e.g. 'Data Engineer · Python, SQL, ETL'"),
  summary: z.string().describe("3-4 sentence profile aimed at this job"),
  skills: z.array(z.object({ label: z.string(), items: z.string() })).describe("3-5 rows, most relevant first"),
  experience: z.array(
    z.object({
      title: z.string(),
      org: z.string(),
      dates: z.string(),
      bullets: z.array(z.string()),
    }),
  ),
  projects: z.array(z.object({ name: z.string(), detail: z.string() })),
  education: z.array(z.string()),
});
export type Cv = z.infer<typeof Cv>;

const Tailored = z.object({
  cv: Cv,
  cover_letter: z.string().describe("Plain text, 3-4 short paragraphs, no greeting/sign-off lines"),
  keywords_matched: z.array(z.string()).describe("Key requirements from the ad that the CV now evidences"),
  keywords_missing: z.array(z.string()).describe("Key requirements the candidate genuinely can't evidence"),
});
export type Tailored = z.infer<typeof Tailored>;

const Check = z.object({
  unsupported: z.array(
    z.object({ claim: z.string(), problem: z.string() }),
  ).describe("Every statement in the CV or letter not supported by the master profile"),
});
export type Check = z.infer<typeof Check>;

export function masterNeedsConfirming(master = loadMasterRaw()): boolean {
  return /^##\s+To confirm/im.test(master);
}

const WRITING_RULES = `Writing rules:
- Use only facts in the master profile. You may select, reorder, merge, trim and reword. Never add employers, titles, dates, numbers, tools, certifications or outcomes that are not there. If the ad wants something the candidate lacks, leave it out; don't hint at it.
- Don't add frequency ("every week"), scale, duties, or links between features that the profile doesn't state. When unsure whether a phrase is supported, leave it out: a shorter true CV beats a longer embellished one.
- Keep dates and job titles exactly as written in the profile.
- UK English. Plain, specific and confident. No buzzwords ("passionate", "leverage", "spearheaded", "synergy", "results-driven", "dynamic"), no em dashes, no exclamation marks.
- Lead bullets with what was built or done, then the result. Keep every metric that's relevant.
- CV fits on 2 A4 pages: 3-5 bullets for the most relevant roles, 1-2 for the rest, and drop roles that don't help this application (keep the timeline honest: no gap-hiding inventions).
- Mirror the ad's own terms where the candidate really has that skill, so ATS keyword filters match.
- Cover letter: under 250 words. Open with why this role at this company (use specifics from the ad), then 2-3 concrete proofs from the profile, then a short close. No "I am writing to apply".`;

export async function tailor(job: JobRow, s: Settings = loadSettings(), master = loadMaster(), fix?: Check["unsupported"]): Promise<Tailored> {
  const track = s.targets.find((t) => t.track === job.track);
  return structured({
    model: s.models.writing,
    effort: "high",
    system: `You tailor a candidate's CV and cover letter to one job ad.

${WRITING_RULES}

<master_profile>
${master}
</master_profile>`,
    user: `<job>
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Angle: ${track ? `${track.track} (${track.titles.slice(0, 8).join(", ")})${track.angle ? `\nHow to pitch: ${track.angle}` : ""}` : job.track ?? "best fit"}
Description:
${job.description.slice(0, 20000)}
</job>
${fix?.length ? `\nA fact-check of your previous draft flagged these unsupported statements. Remove or correct every one:\n${fix.map((f) => `- "${f.claim}": ${f.problem}`).join("\n")}` : ""}`,
    schema: Tailored,
  });
}

export async function factCheck(t: Tailored, s: Settings = loadSettings(), master = loadMaster()): Promise<Check> {
  return structured({
    model: s.models.writing,
    effort: "medium",
    maxTokens: 16000,
    system: `You are a strict fact-checker. Compare a tailored CV and cover letter against the candidate's master profile and list every statement that the profile does not support: invented tools, employers, titles, dates, numbers, certifications, responsibilities or outcomes, and inflated claims (e.g. "led a team" when the profile doesn't say so). Rewording and summarising true facts is fine. Opinions about motivation in the cover letter are fine. Return an empty list if everything is supported.

<master_profile>
${master}
</master_profile>`,
    user: JSON.stringify({ cv: t.cv, cover_letter: t.cover_letter }),
    schema: Check,
  });
}

/** Draft, fact-check, and redraft once if the checker finds anything. */
export async function tailorChecked(job: JobRow): Promise<{ tailored: Tailored; check: Check }> {
  const s = loadSettings();
  const master = loadMaster();
  let tailored = await tailor(job, s, master);
  let check = await factCheck(tailored, s, master);
  // Up to two redrafts; anything still flagged is shown on the review screen.
  for (let i = 0; i < 2 && check.unsupported.length; i++) {
    tailored = await tailor(job, s, master, check.unsupported);
    check = await factCheck(tailored, s, master);
  }
  return { tailored, check };
}
