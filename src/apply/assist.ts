import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { DATA_DIR, loadSettings } from "../config.js";
import { db, type JobRow } from "../db.js";
import { answerFields } from "./answer.js";
import { extractFields, type FormField } from "./form.js";
import { fillField } from "./submit.js";

/**
 * "Fill for me": a visible browser on the Mac that fills whatever application form is on screen
 * (Workday, company sites, anything) and never submits. The person logs in where needed, checks the
 * page, clicks Next/Submit themselves, and can ask for the next page to be filled.
 *
 * It uses its own browser profile so it can run while the headless pipeline is busy; logins made
 * here are remembered for next time.
 */
let ctx: BrowserContext | null = null;
const pages = new Map<number, Page>();

async function context() {
  if (ctx) return ctx;
  ctx = await chromium.launchPersistentContext(path.join(DATA_DIR, "assist-profile"), {
    headless: false,
    viewport: null,
    locale: "en-GB",
    timezoneId: "Europe/London",
    args: ["--start-maximized"],
  });
  await ctx.addInitScript("globalThis.__name = globalThis.__name || ((f) => f);");
  ctx.on("close", () => {
    ctx = null;
    pages.clear();
  });
  return ctx;
}

export interface AssistResult {
  filled: number;
  skipped: string[];
  note?: string;
}

const key = (f: FormField) => `${f.label}|${f.kind}`.toLowerCase();

/** Open the job's application page (or reuse it) and fill the form currently showing. */
export async function assist(job: JobRow, files: { cv: string; cover?: string | null }, coverLetter: string): Promise<AssistResult> {
  const c = await context();
  let page = pages.get(job.id);
  if (!page || page.isClosed()) {
    page = await c.newPage();
    pages.set(job.id, page);
    await page.goto(job.apply_url ?? job.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  }
  await page.bringToFront();

  // Login and sign-up screens are the person's to complete.
  if (await page.locator('input[type="password"]:visible').count()) {
    return { filled: 0, skipped: [], note: "Sign in on the Mac, then tap Fill this page" };
  }

  const fields = await extractFields(page);
  if (!fields.length) return { filled: 0, skipped: [], note: "No form on this page yet. Open the application, then tap Fill this page" };

  // Reuse answers already drafted for this job; only ask the model about new questions.
  const row = db.prepare("SELECT fields_json FROM applications WHERE job_id = ?").get(job.id) as { fields_json: string } | undefined;
  const known = new Map<string, FormField>((row ? (JSON.parse(row.fields_json) as FormField[]) : []).map((f) => [key(f), f]));
  const fresh = fields.filter((f) => !known.has(key(f)));
  const answered = fresh.length ? await answerFields(fresh, job, loadSettings(), coverLetter) : [];
  for (const f of answered) known.set(key(f), f);

  let filled = 0;
  const skipped: string[] = [];
  for (const f of fields) {
    const a = known.get(key(f));
    if (!a || a.value === undefined || a.value === "" || (Array.isArray(a.value) && !a.value.length)) {
      if (f.required) skipped.push(f.label);
      continue;
    }
    try {
      await fillField(page, { ...f, value: a.value }, files);
      filled++;
    } catch {
      skipped.push(f.label);
    }
  }

  db.prepare("UPDATE applications SET fields_json = ? WHERE job_id = ?").run(JSON.stringify([...known.values()]), job.id);
  return { filled, skipped, note: "Check the page, then press Next or Submit yourself" };
}

export async function closeAssist() {
  await ctx?.close();
  ctx = null;
}
