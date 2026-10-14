import { z } from "zod";
import { loadMaster, type Settings } from "../config.js";
import type { JobRow } from "../db.js";
import { structured } from "../llm.js";
import type { FormField } from "./form.js";

const has = (label: string, re: RegExp) => re.test(label.toLowerCase());

/** Fill the obvious fields from settings without a model call. */
function fromProfile(f: FormField, s: Settings): Partial<FormField> | null {
  const c = s.candidate;
  const l = `${f.label} ${f.key}`.toLowerCase();
  if (f.kind === "file") {
    if (has(l, /cover/)) return { value: "cover" };
    if (has(l, /resume|cv|curriculum/)) return { value: "cv" };
    return null;
  }
  if (has(l, /first.?name|given.?name|forename/)) return { value: c.first_name };
  if (has(l, /last.?name|surname|family.?name/)) return { value: c.last_name };
  if (has(l, /preferred.?name/)) return { value: c.first_name };
  if (has(l, /^(full )?name\b|full.?name|your name/) && !has(l, /company|employer|reference/)) return { value: `${c.first_name} ${c.last_name}` };
  if (f.kind === "email" || has(l, /e-?mail/)) return { value: c.email };
  if (f.kind === "tel" || has(l, /phone|mobile|telephone/)) return { value: c.phone };
  if (has(l, /linkedin/) && f.kind !== "radio") return c.linkedin ? { value: c.linkedin } : null;
  if (has(l, /github/)) return c.github ? { value: c.github } : null;
  if (has(l, /website|portfolio|personal (site|url)/)) return c.website || c.github ? { value: c.website || c.github } : null;
  if (has(l, /^(current )?location|city|where are you (based|located)/) && ["text", "combobox"].includes(f.kind)) return { value: c.location };
  return null;
}

const Answers = z.object({
  answers: z.array(
    z.object({
      key: z.string(),
      value: z.union([z.string(), z.array(z.string())]).describe("For select/radio/checkbox, use the option text exactly; checkbox groups may list several"),
      confidence: z.enum(["high", "low"]).describe("low = the candidate should check this before submitting"),
      note: z.string().nullable().describe("Why it's low confidence, else null"),
    }),
  ),
});

export async function answerFields(fields: FormField[], job: JobRow, s: Settings, coverLetter: string): Promise<FormField[]> {
  const out = fields.map((f) => ({ ...f }));
  const pending: FormField[] = [];
  for (const f of out) {
    const p = fromProfile(f, s);
    if (p) Object.assign(f, p, { source: "profile", confidence: "high" });
    else if (f.kind === "file") Object.assign(f, { source: "you", confidence: "low", note: "Unknown file upload" });
    else if (has(`${f.label}`, /cover letter/) && f.kind === "textarea") Object.assign(f, { value: coverLetter, source: "ai", confidence: "high" });
    else pending.push(f);
  }
  if (!pending.length) return out;

  const r = await structured({
    model: s.models.writing,
    effort: "medium",
    maxTokens: 16000,
    system: `You fill in job application forms for one candidate. Use the standard answers verbatim when a question matches one. Otherwise answer from the master profile only, truthfully, in UK English, in the candidate's voice. Never invent experience, qualifications or numbers. Keep free-text answers short (2-5 sentences) and specific to the job. For EEO/diversity questions use the standard answers or "Prefer not to say"/"Decline to self-identify" options. For consent/privacy checkboxes that are required, tick them. Mark anything you're unsure of as low confidence, including any question about salary, visas, criminal records, or exact years of experience in a specific tool.

<standard_answers>
${Object.entries(s.answers)
  .map(([k, v]) => `${k}: ${v}`)
  .join("\n")}
</standard_answers>

<master_profile>
${loadMaster()}
</master_profile>`,
    user: `Job: ${job.title} at ${job.company} (${job.location})
Job description (excerpt):
${job.description.slice(0, 6000)}

Fields to answer (JSON):
${JSON.stringify(pending.map((f) => ({ key: f.key, label: f.label, kind: f.kind, required: f.required, options: f.options })), null, 1)}`,
    schema: Answers,
  });

  for (const a of r.answers) {
    const f = out.find((x) => x.key === a.key);
    if (!f) continue;
    f.value = a.value;
    f.source = "ai";
    f.confidence = a.confidence;
    f.note = a.note ?? undefined;
  }
  for (const f of pending) if (f.value === undefined && f.required) Object.assign(f, { source: "you", confidence: "low", note: "No answer drafted" });
  return out;
}
