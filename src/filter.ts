import type { Settings } from "./config.js";
import type { RawJob } from "./sources/types.js";

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();

export function dedupeKey(company: string, title: string) {
  const c = norm(company).replace(/\b(ltd|limited|plc|inc|llc|group|uk)\b/g, "").replace(/\s+/g, "");
  const t = norm(title).replace(/\s+/g, "");
  return `${c}|${t}`;
}

/** Which target track (if any) a title belongs to. */
export function matchTrack(title: string, s: Settings): string | null {
  const t = ` ${norm(title)} `;
  for (const target of s.targets) {
    for (const phrase of target.titles) {
      const p = norm(phrase);
      if (t.includes(` ${p} `)) return target.track;
      const words = p.split(" ");
      if (words.length > 1 && words.every((w) => t.includes(` ${w} `))) return target.track;
    }
  }
  return null;
}

const UK_ONLY = /^(uk|united kingdom|england|great britain|gb|britain)( area)?$/;
const UK_FRIENDLY = /\b(uk|united kingdom|england|scotland|wales|emea|europe|worldwide|anywhere|global|gmt)\b/;
const REMOTE = /\b(remote|work from home|wfh|anywhere)\b/;

/**
 * Pass: a commutable place, a UK-wide listing, or remote that's open to the UK.
 * Anything vaguer is left for the scorer, which reads the full ad.
 */
export function locationOk(location: string, s: Settings): boolean {
  const l = norm(location);
  if (!l) return true;
  if (s.locations.local.some((w) => ` ${l} `.includes(` ${norm(w)} `))) return true;
  const parts = l.split(/\s{2,}| (?=remote|hybrid)/).map((x) => x.trim());
  if (UK_ONLY.test(l) || parts.some((p) => UK_ONLY.test(p))) return true;
  if (s.locations.remote_ok && REMOTE.test(l)) {
    if (/^(remote|fully remote|100 remote|anywhere|anywhere in the world)$/.test(l)) return true;
    return UK_FRIENDLY.test(l);
  }
  return false;
}

function salaryTooLow(salary: string | null | undefined, min: number): boolean {
  if (!salary || !min || !/£|gbp/i.test(salary)) return false;
  const nums = [...salary.replace(/,/g, "").matchAll(/(\d+(?:\.\d+)?)\s*(k)?/gi)].map((m) => Number(m[1]) * (m[2] ? 1000 : 1));
  const annual = nums.filter((n) => n >= 1000);
  if (!annual.length) return false;
  return Math.max(...annual) < min;
}

/** Returns a reason string if the job should be dropped, or null if it passes. */
export function ruleFilter(j: RawJob, s: Settings): string | null {
  const title = ` ${norm(j.title)} `;
  for (const w of s.exclude.title_words) if (title.includes(` ${norm(w)} `)) return `title: ${w}`;
  if (!matchTrack(j.title, s)) return "title: not a target role";
  if (s.exclude.companies.some((c) => norm(c) === norm(j.company))) return "company excluded";
  if (!locationOk(j.location, s)) return `location: ${j.location}`;
  const d = j.description.toLowerCase();
  for (const p of s.exclude.description_phrases) if (d.includes(p.toLowerCase())) return `description: ${p}`;
  if (salaryTooLow(j.salary, s.salary.min_gbp)) return `salary: ${j.salary}`;
  if (j.posted_at) {
    const age = (Date.now() - new Date(j.posted_at).getTime()) / 86400000;
    if (age > s.pipeline.max_age_days) return "too old";
  }
  return null;
}
