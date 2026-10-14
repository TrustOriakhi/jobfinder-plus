import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cron from "node-cron";
import { env, loadSettings, ROOT, SHOTS_DIR } from "./config.js";
import { db, getJob, setStatus, type JobRow } from "./db.js";
import type { FormField } from "./apply/form.js";
import { AUTO_ATS, fileExists, getApplication, isRunning, prepare, recentLog, runCycle } from "./pipeline.js";
import { assist } from "./apply/assist.js";
import { closeRenderer, cvHtml, htmlToPdf, letterHtml } from "./render.js";
import { masterNeedsConfirming } from "./tailor.js";
import { backend, cliLoggedIn } from "./llm.js";

let claudeReady = backend === "api" ? !!process.env.ANTHROPIC_API_KEY : false;
const checkClaude = async () => {
  if (backend === "cli") claudeReady = await cliLoggedIn();
};
void checkClaude();
setInterval(checkClaude, 5 * 60_000);

const s = loadSettings();
const task = cron.schedule(s.pipeline.discover_cron, () => void runCycle("full"), { timezone: "Europe/London" });

const app = express();
app.use(express.json({ limit: "2mb" }));

// Token gate: required whenever the dashboard is reachable from other devices.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!env.dashboardToken) return next();
  const cookie = req.headers.cookie?.match(/jf_token=([^;]+)/)?.[1];
  const given = (req.query.t as string) ?? req.headers["x-token"] ?? cookie;
  if (given !== env.dashboardToken) return res.status(401).send("Unauthorised");
  if (req.query.t) res.setHeader("set-cookie", `jf_token=${env.dashboardToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
  next();
});

app.use(express.static(path.join(ROOT, "web")));

const STATUSES = ["new", "filtered", "low", "shortlisted", "ready", "approved", "submitted", "manual", "needs_you", "skipped", "failed"];

app.get("/api/summary", (_req, res) => {
  const counts = Object.fromEntries((db.prepare("SELECT status, COUNT(*) n FROM jobs GROUP BY status").all() as { status: string; n: number }[]).map((r) => [r.status, r.n]));
  const outreach = (db.prepare("SELECT COUNT(*) n FROM outreach o JOIN jobs j ON j.id = o.job_id WHERE o.status = 'todo' AND j.status IN ('submitted','approved','manual','ready')").get() as { n: number }).n;
  const lastRun = db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").get();
  const week = db
    .prepare(
      `SELECT
         COUNT(*) AS found,
         SUM(status != 'filtered') AS passed,
         SUM(score IS NOT NULL) AS scored,
         SUM(status IN ('shortlisted','ready','approved','submitted','manual','needs_you')) AS matched,
         SUM(status IN ('ready','approved','submitted','manual','needs_you')) AS prepared,
         SUM(status = 'submitted') AS applied
       FROM jobs WHERE found_at >= datetime('now', '-7 days')`,
    )
    .get();
  const appliedTotal = (db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'submitted'").get() as { n: number }).n;
  res.json({
    counts,
    week,
    appliedTotal,
    outreach,
    running: isRunning(),
    nextRun: task.getNextRun()?.toISOString() ?? null,
    lastRun,
    log: recentLog().slice(-40),
    warnings: [
      masterNeedsConfirming() && "Confirm profile/master.md",
      !claudeReady && (backend === "cli" ? "Claude CLI not logged in" : "ANTHROPIC_API_KEY missing"),
      !env.reedKey && "Reed off (no key)",
      !(env.adzunaId && env.adzunaKey) && "Adzuna off (no key)",
      !loadSettings().candidate.linkedin && "Add your LinkedIn URL in settings",
    ].filter(Boolean),
  });
});

app.get("/api/jobs", (req, res) => {
  const status = String(req.query.status ?? "ready");
  if (status === "outreach") {
    return res.json(
      db
        .prepare(
          `SELECT j.id, j.title, j.company, j.location, j.score, j.status, o.status AS outreach_status
           FROM outreach o JOIN jobs j ON j.id = o.job_id
           WHERE j.status IN ('submitted','approved','manual','ready') ORDER BY o.status = 'todo' DESC, j.updated_at DESC LIMIT 200`,
        )
        .all(),
    );
  }
  if (!STATUSES.includes(status)) return res.status(400).json({ error: "bad status" });
  res.json(
    db
      .prepare(
        `SELECT id, title, company, location, score, track, source, ats, salary, status, error, found_at, updated_at,
           (ats IN (${AUTO_ATS})) AS auto
         FROM jobs WHERE status = ? ORDER BY (ats IN (${AUTO_ATS})) DESC, score DESC NULLS LAST, updated_at DESC LIMIT 300`,
      )
      .all(status),
  );
});

app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).end();
  const application = getApplication(job.id);
  const outreach = db.prepare("SELECT * FROM outreach WHERE job_id = ?").get(job.id) as Record<string, string> | undefined;
  res.json({
    job: { ...job, score_json: job.score_json ? JSON.parse(job.score_json) : null },
    application: application && {
      cv: JSON.parse(application.cv_json),
      cover_letter: application.cover_letter,
      fields: JSON.parse(application.fields_json),
      check: application.check_json ? JSON.parse(application.check_json) : null,
      has_cover_pdf: fileExists(application.cover_pdf),
      shot: application.shot ? path.basename(application.shot) : null,
      submitted_at: application.submitted_at,
    },
    outreach: outreach && { ...outreach, searches: JSON.parse(outreach.searches_json) },
  });
});

app.get("/api/jobs/:id/file/:kind", (req, res) => {
  const a = getApplication(Number(req.params.id));
  const file = req.params.kind === "cv" ? a?.cv_pdf : a?.cover_pdf;
  if (!file || !fileExists(file)) return res.status(404).end();
  res.sendFile(file);
});

app.get("/api/jobs/:id/cv.html", (req, res) => {
  const a = getApplication(Number(req.params.id));
  if (!a) return res.status(404).end();
  res.type("html").send(cvHtml(JSON.parse(a.cv_json), loadSettings()));
});

app.get("/shots/:file", (req, res) => {
  const file = path.join(SHOTS_DIR, path.basename(req.params.file));
  if (!fileExists(file)) return res.status(404).end();
  res.sendFile(file);
});

app.patch("/api/jobs/:id/fields", (req, res) => {
  const id = Number(req.params.id);
  const a = getApplication(id);
  if (!a) return res.status(404).end();
  const fields: FormField[] = JSON.parse(a.fields_json);
  for (const { key, value } of req.body.fields as { key: string; value: string | string[] }[]) {
    const f = fields.find((x) => x.key === key);
    if (f) Object.assign(f, { value, source: "you", confidence: "high", note: undefined });
  }
  db.prepare("UPDATE applications SET fields_json = ? WHERE job_id = ?").run(JSON.stringify(fields), id);
  res.json({ ok: true });
});

app.patch("/api/jobs/:id/letter", async (req, res) => {
  const id = Number(req.params.id);
  const job = getJob(id);
  const a = getApplication(id);
  if (!job || !a) return res.status(404).end();
  const letter = String(req.body.cover_letter ?? "");
  db.prepare("UPDATE applications SET cover_letter = ? WHERE job_id = ?").run(letter, id);
  if (a.cover_pdf) await htmlToPdf(letterHtml(letter, job.company, loadSettings()), a.cover_pdf);
  const fields: FormField[] = JSON.parse(a.fields_json);
  for (const f of fields) if (f.kind === "textarea" && /cover letter/i.test(f.label)) f.value = letter;
  db.prepare("UPDATE applications SET fields_json = ? WHERE job_id = ?").run(JSON.stringify(fields), id);
  await closeRenderer();
  res.json({ ok: true });
});

app.patch("/api/jobs/:id/cv", async (req, res) => {
  const id = Number(req.params.id);
  const a = getApplication(id);
  if (!a) return res.status(404).end();
  const cv = req.body.cv;
  db.prepare("UPDATE applications SET cv_json = ? WHERE job_id = ?").run(JSON.stringify(cv), id);
  await htmlToPdf(cvHtml(cv, loadSettings()), a.cv_pdf);
  await closeRenderer();
  res.json({ ok: true });
});

const transition = (from: string[], to: Parameters<typeof setStatus>[1]) => (req: Request, res: Response) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).end();
  if (!from.includes(job.status)) return res.status(409).json({ error: `job is ${job.status}` });
  setStatus(job.id, to);
  if (to === "approved") void runCycle("submit");
  if (to === "submitted") db.prepare("UPDATE applications SET submitted_at = datetime('now') WHERE job_id = ?").run(job.id);
  res.json({ ok: true });
};

app.post("/api/jobs/:id/approve", transition(["ready", "needs_you"], "approved"));
app.post("/api/jobs/:id/skip", transition(["ready", "manual", "needs_you", "shortlisted", "low", "failed"], "skipped"));
app.post("/api/jobs/:id/applied", transition(["ready", "manual", "needs_you", "failed", "approved"], "submitted"));
app.post("/api/jobs/:id/prepare", async (req, res) => {
  const job = getJob(Number(req.params.id)) as JobRow | undefined;
  if (!job) return res.status(404).end();
  try {
    await prepare(job);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// "Fill for me": opens a visible browser on the Mac and fills the current page. Never submits.
app.post("/api/jobs/:id/assist", async (req, res) => {
  const job = getJob(Number(req.params.id));
  const a = job && getApplication(job.id);
  if (!job || !a) return res.status(404).json({ error: "Prepare the application first" });
  try {
    res.json(await assist(job, { cv: a.cv_pdf, cover: a.cover_pdf }, a.cover_letter));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/jobs/:id/outreach/:state", (req, res) => {
  const state = req.params.state === "sent" ? "sent" : req.params.state === "skip" ? "skipped" : "todo";
  db.prepare("UPDATE outreach SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE sent_at END WHERE job_id = ?").run(state, state, Number(req.params.id));
  res.json({ ok: true });
});

app.post("/api/run", (_req, res) => {
  void runCycle("full");
  res.json({ ok: true });
});


const host = env.dashboardToken ? "0.0.0.0" : "127.0.0.1";
app.listen(env.port, host, () => {
  console.log(`Jobfinder+ on http://${host === "0.0.0.0" ? "<this-mac>.local" : "localhost"}:${env.port}${env.dashboardToken ? "/?t=<DASHBOARD_TOKEN>" : ""}`);
  console.log(`Runs on schedule: ${s.pipeline.discover_cron}`);
});
