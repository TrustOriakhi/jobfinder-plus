import fs from "node:fs";
import { loadSettings } from "./config.js";
import { db, getJob, jobsWithStatus, setStatus, type JobRow } from "./db.js";
import { discover } from "./discover.js";
import { answerFields } from "./apply/answer.js";
import { closeContext, formUrl, openForm } from "./apply/browser.js";
import { extractFields, type FormField } from "./apply/form.js";
import { submitApplication } from "./apply/submit.js";
import { draftOutreach } from "./outreach.js";
import { closeRenderer, cvHtml, docPath, htmlToPdf, letterHtml } from "./render.js";
import { scoreNew } from "./score.js";
import { masterNeedsConfirming, tailorChecked } from "./tailor.js";

type Log = (m: string) => void;

/** Boards the bot can submit to by itself. Roles on these get a ranking boost: one tap applies. */
export const AUTO_ATS = "'greenhouse','lever','ashby','workable'";
const AUTO_BONUS = 8;

export interface ApplicationRow {
  job_id: number;
  cv_json: string;
  cv_pdf: string;
  cover_letter: string;
  cover_pdf: string | null;
  fields_json: string;
  check_json: string | null;
  submitted_at: string | null;
  shot: string | null;
}

export const getApplication = (jobId: number) =>
  db.prepare("SELECT * FROM applications WHERE job_id = ?").get(jobId) as ApplicationRow | undefined;

/** Tailor CV + letter, render PDFs, read the live form and draft answers. Leaves the job in "ready" (or "manual"). */
export async function prepare(job: JobRow, log: Log = console.log) {
  if (masterNeedsConfirming()) throw new Error("profile/master.md still has a 'To confirm' section");
  const s = loadSettings();
  log(`tailoring ${job.title} @ ${job.company}`);
  const { tailored, check } = await tailorChecked(job);
  const cvPdf = await htmlToPdf(cvHtml(tailored.cv, s), docPath(job.id, "cv", s, job.company));
  const coverPdf = await htmlToPdf(letterHtml(tailored.cover_letter, job.company, s), docPath(job.id, "cover-letter", s, job.company));

  let fields: FormField[] = [];
  let status: "ready" | "manual" = "manual";
  let note: string | null = job.ats ? null : "No supported form: apply with the docs";
  if (formUrl(job)) {
    try {
      const page = await openForm(job);
      fields = await extractFields(page);
      await page.close();
      if (fields.length) {
        fields = await answerFields(fields, job, s, tailored.cover_letter);
        status = "ready";
      } else note = "Form not found";
    } catch (e) {
      note = `Form: ${(e as Error).message}`;
    }
  }

  db.prepare(
    `INSERT INTO applications (job_id, cv_json, cv_pdf, cover_letter, cover_pdf, fields_json, check_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (job_id) DO UPDATE SET cv_json = excluded.cv_json, cv_pdf = excluded.cv_pdf, cover_letter = excluded.cover_letter,
       cover_pdf = excluded.cover_pdf, fields_json = excluded.fields_json, check_json = excluded.check_json`,
  ).run(
    job.id,
    JSON.stringify({ ...tailored.cv, keywords_matched: tailored.keywords_matched, keywords_missing: tailored.keywords_missing }),
    cvPdf,
    tailored.cover_letter,
    coverPdf,
    JSON.stringify(fields),
    JSON.stringify(check),
  );
  setStatus(job.id, status, note);

  try {
    await draftOutreach(job);
  } catch (e) {
    log(`outreach draft failed: ${(e as Error).message}`);
  }
}

export async function prepareShortlisted(log: Log = console.log) {
  const s = loadSettings();
  if (masterNeedsConfirming()) {
    log("skipping prepare: confirm profile/master.md first");
    return { prepared: 0 };
  }
  const today = (db.prepare("SELECT COUNT(*) n FROM applications WHERE date(created_at) = date('now')").get() as { n: number }).n;
  const budget = Math.max(0, s.pipeline.max_prepared_per_day - today);
  // Direct ATS forms first: those are the ones the bot can actually submit.
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE status = 'shortlisted' ORDER BY score + ${AUTO_BONUS} * (ats IN (${AUTO_ATS})) DESC LIMIT ?`)
    .all(budget) as JobRow[];
  let prepared = 0;
  for (const job of rows) {
    try {
      await prepare(job, log);
      prepared++;
    } catch (e) {
      setStatus(job.id, "failed", `prepare: ${(e as Error).message}`);
      log(`prepare failed ${job.id}: ${(e as Error).message}`);
    }
  }
  await closeRenderer();
  await closeContext();
  return { prepared };
}

export async function submitApproved(log: Log = console.log) {
  const rows = jobsWithStatus("approved", 50);
  for (const job of rows) {
    const app = getApplication(job.id);
    if (!app) continue;
    log(`submitting ${job.title} @ ${job.company}`);
    try {
      const r = await submitApplication(job, JSON.parse(app.fields_json), { cv: app.cv_pdf, cover: app.cover_pdf });
      db.prepare("UPDATE applications SET shot = ?, submitted_at = CASE WHEN ? THEN datetime('now') ELSE submitted_at END WHERE job_id = ?").run(r.shot, r.ok ? 1 : 0, job.id);
      setStatus(job.id, r.ok ? "submitted" : "needs_you", r.ok ? null : r.reason ?? null);
      log(r.ok ? "  submitted" : `  needs you: ${r.reason}`);
    } catch (e) {
      setStatus(job.id, "needs_you", (e as Error).message);
    }
  }
  await closeContext();
  return { attempted: rows.length };
}

let running: Promise<unknown> | null = null;
const logLines: string[] = [];
export const recentLog = () => logLines.slice(-200);
const logger: Log = (m) => {
  const line = `${new Date().toLocaleTimeString("en-GB")} ${m}`;
  logLines.push(line);
  if (logLines.length > 1000) logLines.splice(0, 500);
  console.log(line);
};

/** One full cycle. Only one runs at a time. */
export function runCycle(kind: "full" | "submit" = "full") {
  if (running) return running;
  const id = db.prepare("INSERT INTO runs (kind) VALUES (?)").run(kind).lastInsertRowid;
  running = (async () => {
    const summary: Record<string, unknown> = {};
    try {
      if (kind === "full") {
        Object.assign(summary, await discover(logger));
        Object.assign(summary, await scoreNew(logger));
        Object.assign(summary, await prepareShortlisted(logger));
      }
      Object.assign(summary, await submitApproved(logger));
    } catch (e) {
      summary.error = (e as Error).message;
      logger(`run failed: ${(e as Error).message}`);
    } finally {
      db.prepare("UPDATE runs SET ended_at = datetime('now'), summary = ? WHERE id = ?").run(JSON.stringify(summary), id);
      running = null;
    }
    return summary;
  })();
  return running;
}
export const isRunning = () => running !== null;

export function fileExists(p: string | null | undefined) {
  return !!p && fs.existsSync(p);
}

export { getJob };
