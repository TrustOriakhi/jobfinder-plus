import { z } from "zod";
import { loadMaster, loadSettings } from "./config.js";
import { db, type JobRow } from "./db.js";
import { structured } from "./llm.js";

const Draft = z.object({
  people: z.array(z.object({ who: z.string().describe("e.g. 'Head of Data', 'Technical recruiter'"), keywords: z.string().describe("LinkedIn people-search keywords, no company name") })).describe("2-3 people most likely to influence this hire"),
  note: z.string().describe("Connection request note, max 280 characters"),
  followup: z.string().describe("Message to send once they accept, max 600 characters"),
});

export interface OutreachSearch {
  who: string;
  url: string;
}

function peopleSearchUrl(keywords: string, company: string) {
  return `https://www.linkedin.com/search/results/people/?${new URLSearchParams({ keywords: `${keywords} ${company}`, origin: "GLOBAL_SEARCH_HEADER" })}`;
}

/** Draft LinkedIn outreach for a job. Nothing is sent: you open the search, pick the person, paste the note. */
export async function draftOutreach(job: JobRow) {
  const s = loadSettings();
  const d = await structured({
    model: s.models.writing,
    effort: "medium",
    maxTokens: 8000,
    system: `You write short LinkedIn outreach for a job seeker, ${s.candidate.first_name}. Tone: warm, direct, human, UK English. No flattery, no buzzwords, no em dashes, no "I hope this finds you well". Mention the specific role and one concrete, true thing from the profile that fits it. The note must not ask for a job outright; ask a light question or say you've applied and would value being on their radar. Use only true facts from the profile.

<master_profile>
${loadMaster()}
</master_profile>`,
    user: `Role: ${job.title} at ${job.company} (${job.location})
Ad excerpt:
${job.description.slice(0, 4000)}`,
    schema: Draft,
  });
  const searches: OutreachSearch[] = [
    ...d.people.map((p) => ({ who: p.who, url: peopleSearchUrl(p.keywords, job.company) })),
    { who: "Recruiters", url: peopleSearchUrl("talent acquisition recruiter", job.company) },
  ];
  db.prepare(
    `INSERT INTO outreach (job_id, searches_json, note, followup) VALUES (?, ?, ?, ?)
     ON CONFLICT (job_id) DO UPDATE SET searches_json = excluded.searches_json, note = excluded.note, followup = excluded.followup`,
  ).run(job.id, JSON.stringify(searches), d.note.slice(0, 300), d.followup);
  return { searches, note: d.note, followup: d.followup };
}
