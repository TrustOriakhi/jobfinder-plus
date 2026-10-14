import path from "node:path";
import type { Page } from "playwright";
import { SHOTS_DIR } from "../config.js";
import type { JobRow } from "../db.js";
import { openForm } from "./browser.js";
import { hasCaptchaChallenge, type FormField } from "./form.js";

export interface SubmitResult {
  ok: boolean;
  reason?: string;
  shot: string;
}

const asList = (v: FormField["value"]) => (Array.isArray(v) ? v : v ? [v] : []);
const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function fillField(page: Page, f: FormField, files: { cv: string; cover?: string | null }) {
  const values = asList(f.value);
  if (!values.length) return;
  const el = page.locator(f.selector).first();
  switch (f.kind) {
    case "file": {
      const file = values[0] === "cover" ? files.cover : files.cv;
      if (file) await page.locator(f.selector).first().setInputFiles(file);
      return;
    }
    case "select": {
      const opts = await el.locator("option").evaluateAll((os) => os.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent ?? "" })));
      const pick = (v: string) => opts.find((o) => loose(o.text) === loose(v)) ?? opts.find((o) => loose(o.text).includes(loose(v)));
      const chosen = values.map(pick);
      if (chosen.some((o) => !o)) throw new Error(`no option matching ${values.join(", ")}`);
      await el.selectOption(chosen.map((o) => ({ value: o!.value })), { timeout: 5000 });
      return;
    }
    case "radio":
    case "checkbox": {
      const inputs = page.locator(f.selector);
      const n = await inputs.count();
      for (let i = 0; i < n; i++) {
        const input = inputs.nth(i);
        const id = await input.getAttribute("id");
        const text = id
          ? await page.locator(`label[for="${id}"]`).first().textContent().catch(() => null)
          : await input.locator("xpath=ancestor::label[1]").textContent().catch(() => null);
        const label = loose(text ?? (await input.getAttribute("value")) ?? "");
        if (values.some((v) => loose(v) === label || (n === 1 && /^(yes|true|i agree|agree)/i.test(v)))) {
          // Styled inputs sometimes ignore a direct check; clicking the label works there.
          await input.check({ force: true, timeout: 5000 }).catch(async () => {
            const lab = id ? page.locator(`label[for="${id}"]`).first() : input.locator("xpath=ancestor::label[1]");
            await lab.click({ timeout: 5000 });
          });
        }
      }
      return;
    }
    case "combobox": {
      await el.click();
      await el.fill(values[0]);
      await page.waitForTimeout(600);
      const option = page.getByRole("option", { name: new RegExp(values[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).first();
      if (await option.isVisible().catch(() => false)) await option.click();
      else await el.press("Enter");
      return;
    }
    default:
      await el.fill(values.join(", "));
      // Location fields are often autocompletes that only accept a picked suggestion.
      if (/location|city/i.test(f.label)) {
        await page.waitForTimeout(900);
        const option = page.getByRole("option").first();
        if (await option.isVisible().catch(() => false)) await option.click();
      }
  }
}

const SUCCESS = /thank(s| you) for (applying|your application)|application (has been )?(submitted|received)|we('ve| have) received your application|successfully submitted/i;

/** Fill the live form with the reviewed answers and submit. Stops for a human on captcha or validation errors. */
export async function submitApplication(
  job: JobRow,
  fields: FormField[],
  files: { cv: string; cover?: string | null },
  opts: { dryRun?: boolean } = {},
): Promise<SubmitResult> {
  const page = await openForm(job);
  const shot = (tag: string) => path.join(SHOTS_DIR, `${job.id}-${tag}-${Date.now()}.png`);
  const capture = async (file: string) => {
    const form = page.locator("form").filter({ has: page.locator("input, textarea") }).first();
    if (await form.isVisible().catch(() => false)) await form.screenshot({ path: file }).catch(() => page.screenshot({ path: file, fullPage: true }));
    else await page.screenshot({ path: file, fullPage: true });
    return file;
  };
  try {
    const failed: string[] = [];
    for (const f of fields) {
      try {
        await fillField(page, f, files);
      } catch (e) {
        if (process.env.DEBUG) console.warn(`fill "${f.label}": ${(e as Error).message.split("\n")[0]}`);
        if (f.required) failed.push(f.label);
      }
    }
    if (failed.length) {
      const s = await capture(shot("unfilled"));
      return { ok: false, reason: `Couldn't fill: ${failed.slice(0, 5).join("; ")}`, shot: s };
    }

    const before = await capture(shot("filled"));
    if (opts.dryRun) return { ok: true, reason: "dry run: not submitted", shot: before };

    const submit = page
      .getByRole("button", { name: /submit( application)?|send application|apply$/i })
      .or(page.locator("button[type=submit], input[type=submit]"))
      .last();
    await submit.click();
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const after = shot("after");
    await page.screenshot({ path: after, fullPage: true });
    if (await hasCaptchaChallenge(page)) return { ok: false, reason: "Captcha: finish it yourself", shot: after };

    const body = await page.locator("body").innerText().catch(() => "");
    if (SUCCESS.test(body) || /confirmation|thank|success/i.test(page.url())) return { ok: true, shot: after };

    const errors = await page
      .locator('[class*=error]:visible, [role=alert]:visible, [aria-invalid=true]')
      .allInnerTexts()
      .catch(() => []);
    return { ok: false, reason: errors.filter(Boolean).slice(0, 3).join(" · ") || "No confirmation seen", shot: after };
  } finally {
    await page.close().catch(() => {});
  }
}
