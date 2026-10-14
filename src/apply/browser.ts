import { chromium, type BrowserContext, type Page } from "playwright";
import { BROWSER_PROFILE_DIR } from "../config.js";
import type { JobRow } from "../db.js";

let ctx: BrowserContext | null = null;

/** One persistent profile so cookies and any logins you do with `npm run login` stick. */
export async function context(headed = process.env.HEADED === "1"): Promise<BrowserContext> {
  if (ctx) return ctx;
  ctx = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    locale: "en-GB",
    timezoneId: "Europe/London",
  });
  // tsx/esbuild wraps named functions in a __name() helper that doesn't exist inside the page.
  await ctx.addInitScript("globalThis.__name = globalThis.__name || ((f) => f);");
  ctx.on("close", () => (ctx = null));
  return ctx;
}

export async function closeContext() {
  await ctx?.close();
  ctx = null;
}

/** Where the actual application form lives for each ATS. */
export function formUrl(job: JobRow): string | null {
  const u = job.apply_url ?? job.url;
  switch (job.ats) {
    case "greenhouse":
      return u; // form is on the job page
    case "lever":
      return u.endsWith("/apply") ? u : `${u.replace(/\/$/, "")}/apply`;
    case "ashby":
      return u.endsWith("/application") ? u : `${u.replace(/\/$/, "")}/application`;
    case "workable":
      return u.endsWith("/apply/") || u.endsWith("/apply") ? u : `${u.replace(/\/$/, "")}/apply/`;
    default:
      return null;
  }
}

export async function openForm(job: JobRow): Promise<Page> {
  const url = formUrl(job);
  if (!url) throw new Error("no supported application form");
  const page = await (await context()).newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  // Dismiss cookie banners with the least-permissive choice.
  for (const label of [/reject all/i, /decline/i, /only necessary|necessary only|essential only/i]) {
    const b = page.getByRole("button", { name: label }).first();
    if (await b.isVisible().catch(() => false)) {
      await b.click().catch(() => {});
      break;
    }
  }
  // Some boards hide the form behind an "Apply" button.
  const form = page.locator("form input, form textarea").first();
  if (!(await form.isVisible().catch(() => false))) {
    const apply = page.getByRole("button", { name: /^apply/i }).or(page.getByRole("link", { name: /^apply( for this job| now)?$/i })).first();
    if (await apply.isVisible().catch(() => false)) {
      await apply.click();
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    }
  }
  return page;
}
