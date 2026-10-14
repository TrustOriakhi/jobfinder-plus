import type { Page } from "playwright";

export type FieldKind = "text" | "email" | "tel" | "url" | "number" | "textarea" | "select" | "combobox" | "radio" | "checkbox" | "file" | "date";

export interface FormField {
  key: string;
  label: string;
  kind: FieldKind;
  selector: string; // for radio/checkbox groups: selector of the group's inputs
  required: boolean;
  options: string[];
  multiple: boolean;
  value?: string | string[]; // what we will enter; for files: "cv" | "cover"
  source?: "profile" | "bank" | "ai" | "you";
  confidence?: "high" | "low";
  note?: string;
}

/** Ignore search boxes, cookie banners and other non-application inputs. */
const SKIP = /search|cookie|newsletter|captcha|g-recaptcha|h-captcha|honeypot|autofill/i;

export async function extractFields(page: Page): Promise<FormField[]> {
  const raw = await page.evaluate((skipSource) => {
    const skip = new RegExp(skipSource, "i");
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").replace(/[*✱]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const st = getComputedStyle(el as HTMLElement);
      // File inputs are often visually hidden behind a styled button: keep them.
      return (el as HTMLInputElement).type === "file" || (r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none");
    };
    const labelFor = (el: Element): string => {
      const id = el.getAttribute("id");
      if (id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (l) return clean(l.textContent);
      }
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const t = by
          .split(" ")
          .map((i) => document.getElementById(i)?.textContent)
          .join(" ");
        if (clean(t)) return clean(t);
      }
      if (el.getAttribute("aria-label")) return clean(el.getAttribute("aria-label"));
      const wrap = el.closest("label");
      if (wrap) return clean(wrap.textContent);
      const fs = el.closest("fieldset");
      if (fs?.querySelector("legend")) return clean(fs.querySelector("legend")!.textContent);
      // Nearest preceding label-ish text inside the same field container.
      let p: Element | null = el.parentElement;
      for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
        const l = p.querySelector("label, .label, [class*=label], [class*=Label], legend, h3, h4");
        if (l && clean(l.textContent)) return clean(l.textContent);
      }
      return clean(el.getAttribute("placeholder") || el.getAttribute("name"));
    };
    const sel = (el: Element) => {
      const id = el.getAttribute("id");
      if (id && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) return `#${CSS.escape(id)}`;
      const name = el.getAttribute("name");
      if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
      const all = Array.from(document.querySelectorAll(el.tagName));
      return `${el.tagName.toLowerCase()} >> nth=${all.indexOf(el)}`;
    };

    const out: any[] = [];
    const groups = new Map<string, any>();
    const form = document.querySelector("form#application-form, form#application_form, form[action*=apply], form") ?? document.body;
    for (const el of Array.from(form.querySelectorAll("input, select, textarea"))) {
      const input = el as HTMLInputElement;
      const type = (input.type || el.tagName).toLowerCase();
      if (["hidden", "submit", "button", "image", "reset", "password"].includes(type)) continue;
      if (!visible(el)) continue;
      const name = input.name || input.id || "";
      const label = labelFor(el);
      if (skip.test(name) || skip.test(label)) continue;
      const required = input.required || el.getAttribute("aria-required") === "true" || /\*/.test(document.querySelector(`label[for="${CSS.escape(input.id || "_")}"]`)?.textContent ?? "");

      if (type === "radio" || type === "checkbox") {
        const optLabel = clean(document.querySelector(`label[for="${CSS.escape(input.id || "_")}"]`)?.textContent ?? input.closest("label")?.textContent ?? input.value);
        const fs = input.closest("fieldset");
        const question = clean(fs?.querySelector("legend")?.textContent) || labelFor(input.closest("[role=group], fieldset, div") ?? input);
        // Radios share a name per question. Some boards (Ashby) name each checkbox after its option,
        // so checkboxes are grouped by their question instead.
        const groupKey = type === "checkbox" && question && question !== optLabel ? `q:${question}` : input.name || label;
        let g = groups.get(groupKey);
        if (!g) {
          g = {
            key: groupKey,
            label: question || optLabel,
            kind: type,
            selector: groupKey.startsWith("q:") ? sel(el) : input.name ? `input[name="${CSS.escape(input.name)}"]` : sel(el),
            required,
            options: [],
            multiple: type === "checkbox",
          };
          groups.set(groupKey, g);
          out.push(g);
        }
        if (groupKey.startsWith("q:") && g.options.length) g.selector += `, ${sel(el)}`;
        g.options.push(optLabel);
        g.required ||= required;
        continue;
      }
      if (el.getAttribute("role") === "combobox") {
        out.push({ key: name || sel(el), label, kind: "combobox", selector: sel(el), required, options: [], multiple: false });
        continue;
      }
      out.push({
        key: name || sel(el),
        label,
        kind: el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : ["email", "tel", "url", "number", "file", "date"].includes(type) ? type : "text",
        selector: sel(el),
        required,
        options: el.tagName === "SELECT" ? Array.from((el as HTMLSelectElement).options).map((o) => clean(o.textContent)).filter((o) => o && !/^(select|please select|--)/i.test(o)) : [],
        multiple: (el as HTMLSelectElement).multiple ?? false,
      });
    }
    return out;
  }, SKIP.source);

  // Custom dropdowns and phone pickers render a second, anonymous input with the same label: keep the real one.
  const fields = (raw as FormField[]).filter(
    (f, i, all) => !(f.selector.includes(">> nth=") && all.some((g, j) => j !== i && g.label === f.label && !g.selector.includes(">> nth="))),
  );
  // Single checkbox groups (e.g. consent) read better with the option text as label.
  for (const f of fields) {
    if (f.kind === "checkbox" && f.options.length === 1 && (!f.label || f.label === f.options[0])) f.label = f.options[0];
  }
  // Custom dropdowns only render their options when opened: open each one and read them.
  for (const f of fields) {
    if (f.kind !== "combobox" || /^(current )?(location|city|country)\b|\b(school|university)\b/i.test(f.label)) continue;
    try {
      const box = page.locator(f.selector).first();
      await box.click({ timeout: 3000 });
      for (const wait of [300, 1000]) {
        await page.waitForTimeout(wait);
        f.options = (await page.getByRole("option").allInnerTexts()).map((o) => o.trim()).filter(Boolean).slice(0, 60);
        if (f.options.length) break;
      }
      await box.press("Escape");
    } catch {
      /* leave options empty; the answer gets typed instead */
    }
  }
  return fields;
}

export async function hasCaptchaChallenge(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const u = frame.url();
    if (/recaptcha\/api2\/bframe|hcaptcha\.com\/captcha|challenges\.cloudflare\.com/.test(u)) {
      const el = await frame.frameElement().catch(() => null);
      if (el && (await el.isVisible().catch(() => false))) return true;
    }
  }
  return false;
}
