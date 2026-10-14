import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const ROOT = process.cwd();
export const PROFILE_DIR = path.join(ROOT, "profile");
export const DATA_DIR = path.join(ROOT, "data");
export const DOCS_DIR = path.join(DATA_DIR, "docs");
export const SHOTS_DIR = path.join(DATA_DIR, "shots");
export const BROWSER_PROFILE_DIR = path.join(DATA_DIR, "browser-profile");
for (const d of [DATA_DIR, DOCS_DIR, SHOTS_DIR]) fs.mkdirSync(d, { recursive: true });

const Settings = z.object({
  candidate: z.object({
    first_name: z.string(),
    last_name: z.string(),
    email: z.string(),
    phone: z.string(),
    location: z.string(),
    linkedin: z.string().default(""),
    github: z.string().default(""),
    website: z.string().default(""),
    /** One or two sentences the scorer uses to judge level and fit. */
    background: z.string().default(""),
    /** Where the candidate wants to work, in plain words, for the scorer. */
    location_preference: z.string().default(""),
  }),
  targets: z.array(z.object({ track: z.string(), titles: z.array(z.string()), angle: z.string().optional() })),
  locations: z.object({
    local: z.array(z.string()),
    search: z.array(z.string()),
    remote_ok: z.boolean().default(true),
  }),
  exclude: z.object({
    title_words: z.array(z.string()).default([]),
    companies: z.array(z.string()).default([]),
    description_phrases: z.array(z.string()).default([]),
  }),
  salary: z.object({ min_gbp: z.number().default(0) }),
  pipeline: z.object({
    min_score: z.number().default(70),
    max_prepared_per_day: z.number().default(25),
    max_age_days: z.number().default(14),
    discover_cron: z.string().default("0 7,13,19 * * *"),
  }),
  boards: z.object({
    greenhouse: z.array(z.string()).default([]),
    lever: z.array(z.string()).default([]),
    ashby: z.array(z.string()).default([]),
    workable: z.array(z.string()).default([]),
  }),
  sources: z.object({
    linkedin: z.boolean().default(true),
    reed: z.boolean().default(true),
    adzuna: z.boolean().default(true),
    remoteok: z.boolean().default(true),
    weworkremotely: z.boolean().default(true),
  }),
  answers: z.record(z.string(), z.string()).default({}),
  models: z.object({
    scoring: z.string().default("claude-opus-5-5"),
    writing: z.string().default("claude-opus-5-5"),
  }),
});
export type Settings = z.infer<typeof Settings>;

export function loadSettings(): Settings {
  const file = path.join(PROFILE_DIR, "settings.yaml");
  if (!fs.existsSync(file)) throw new Error("profile/settings.yaml missing: copy profile/settings.example.yaml and fill it in");
  return Settings.parse(YAML.parse(fs.readFileSync(file, "utf8")));
}

export function loadMasterRaw(): string {
  const file = path.join(PROFILE_DIR, "master.md");
  if (!fs.existsSync(file)) throw new Error("profile/master.md missing: copy profile/master.example.md and fill it in");
  return fs.readFileSync(file, "utf8");
}

/** The profile the models see: unconfirmed and to-confirm sections are removed so they can never reach a CV. */
export function loadMaster(): string {
  return loadMasterRaw()
    .split(/^(?=## )/m)
    .filter((section) => !/^## (Not yet confirmed|To confirm)/i.test(section))
    .join("")
    .trim();
}

export const env = {
  port: Number(process.env.PORT ?? 4319),
  dashboardToken: process.env.DASHBOARD_TOKEN ?? "",
  reedKey: process.env.REED_API_KEY ?? "",
  adzunaId: process.env.ADZUNA_APP_ID ?? "",
  adzunaKey: process.env.ADZUNA_APP_KEY ?? "",
};
