import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { DOCS_DIR, type Settings } from "./config.js";
import type { Cv } from "./tailor.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const BASE_CSS = `
@page { size: A4; margin: 14mm 15mm; }
* { box-sizing: border-box; }
body { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 10.2pt; line-height: 1.38; color: #1d1d1f; margin: 0; }
h1 { font-size: 21pt; margin: 0; letter-spacing: -0.01em; }
.headline { font-size: 11pt; color: #3a3a3c; margin: 2px 0 4px; }
.contact { font-size: 9pt; color: #555; }
h2 { font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.08em; color: #0a5c7a; border-bottom: 1px solid #d5dde2; padding-bottom: 2px; margin: 13px 0 6px; }
p { margin: 0 0 6px; }
.skills div { margin-bottom: 2px; }
.skills b { font-weight: 600; }
.role { margin-bottom: 7px; break-inside: avoid; }
.role-head { display: flex; justify-content: space-between; gap: 12px; }
.role-head b { font-weight: 600; }
.role-head span { color: #555; white-space: nowrap; font-size: 9.3pt; }
ul { margin: 2px 0 0; padding-left: 15px; }
li { margin-bottom: 1.5px; }
.letter p { margin-bottom: 10px; font-size: 10.6pt; line-height: 1.5; }
`;

function contactLine(s: Settings) {
  const c = s.candidate;
  return [c.location, c.phone, c.email, c.linkedin, c.github, c.website].filter(Boolean).map(esc).join(" · ");
}

export function cvHtml(cv: Cv, s: Settings): string {
  const name = `${s.candidate.first_name} ${s.candidate.last_name}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)} CV</title><style>${BASE_CSS}</style></head><body>
<h1>${esc(name)}</h1>
<div class="headline">${esc(cv.headline)}</div>
<div class="contact">${contactLine(s)}</div>
<h2>Profile</h2><p>${esc(cv.summary)}</p>
<h2>Skills</h2><div class="skills">${cv.skills.map((r) => `<div><b>${esc(r.label)}:</b> ${esc(r.items)}</div>`).join("")}</div>
<h2>Experience</h2>
${cv.experience
  .map(
    (e) => `<div class="role"><div class="role-head"><b>${esc(e.title)} · ${esc(e.org)}</b><span>${esc(e.dates)}</span></div>
<ul>${e.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>`,
  )
  .join("")}
${cv.projects.length ? `<h2>Projects</h2>${cv.projects.map((p) => `<p><b>${esc(p.name)}</b>: ${esc(p.detail)}</p>`).join("")}` : ""}
<h2>Education</h2>${cv.education.map((e) => `<p>${esc(e)}</p>`).join("")}
</body></html>`;
}

export function letterHtml(letter: string, company: string, s: Settings): string {
  const name = `${s.candidate.first_name} ${s.candidate.last_name}`;
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body class="letter">
<h1>${esc(name)}</h1><div class="contact">${contactLine(s)}</div>
<div class="letter" style="margin-top:22px">
<p>${esc(date)}</p>
<p>Dear ${esc(company)} hiring team,</p>
${letter
  .split(/\n\s*\n/)
  .map((p) => `<p>${esc(p.trim())}</p>`)
  .join("")}
<p>Kind regards,<br>${esc(name)}</p></div></body></html>`;
}

let browser: Browser | null = null;
async function getBrowser() {
  browser ??= await chromium.launch();
  return browser;
}
export async function closeRenderer() {
  await browser?.close();
  browser = null;
}

export function docPath(jobId: number, kind: "cv" | "cover-letter", s: Settings, company: string) {
  const dir = path.join(DOCS_DIR, String(jobId));
  fs.mkdirSync(dir, { recursive: true });
  const safe = company.replace(/[^\w\- ]+/g, "").trim().slice(0, 40);
  const label = kind === "cv" ? "CV" : "Cover Letter";
  return path.join(dir, `${s.candidate.first_name} ${s.candidate.last_name} ${label} - ${safe}.pdf`);
}

export async function htmlToPdf(html: string, out: string) {
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({ path: out, format: "A4", printBackground: true, preferCSSPageSize: true });
  } finally {
    await page.close();
  }
  return out;
}
