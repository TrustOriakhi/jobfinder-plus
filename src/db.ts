import path from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR } from "./config.js";

export const db = new Database(path.join(DATA_DIR, "jobfinder.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  dedupe_key    TEXT NOT NULL,
  company       TEXT NOT NULL,
  title         TEXT NOT NULL,
  location      TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL,
  apply_url     TEXT,
  ats           TEXT,
  description   TEXT NOT NULL DEFAULT '',
  salary        TEXT,
  posted_at     TEXT,
  found_at      TEXT NOT NULL DEFAULT (datetime('now')),
  status        TEXT NOT NULL DEFAULT 'new',
  score         INTEGER,
  track         TEXT,
  score_json    TEXT,
  error         TEXT,
  enriched      INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_dedupe ON jobs(dedupe_key);

CREATE TABLE IF NOT EXISTS applications (
  job_id         INTEGER PRIMARY KEY REFERENCES jobs(id),
  cv_json        TEXT NOT NULL,
  cv_pdf         TEXT NOT NULL,
  cover_letter   TEXT NOT NULL,
  cover_pdf      TEXT,
  fields_json    TEXT NOT NULL DEFAULT '[]',
  check_json     TEXT,
  submitted_at   TEXT,
  shot           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outreach (
  job_id        INTEGER PRIMARY KEY REFERENCES jobs(id),
  searches_json TEXT NOT NULL,
  note          TEXT NOT NULL,
  followup      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'todo',
  sent_at       TEXT
);

CREATE TABLE IF NOT EXISTS learned_boards (
  ats    TEXT NOT NULL,
  token  TEXT NOT NULL,
  PRIMARY KEY (ats, token)
);

CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at   TEXT,
  summary    TEXT
);
`);

export type JobStatus =
  | "new" // found, not scored
  | "filtered" // dropped by rules
  | "low" // scored below threshold
  | "shortlisted" // scored above threshold, waiting to be prepared
  | "ready" // CV + answers ready, waiting for approval
  | "approved" // queued for submission
  | "submitted"
  | "manual" // can't be auto-submitted: apply yourself with the prepared docs
  | "needs_you" // auto-submit got stuck (captcha, unknown field)
  | "skipped"
  | "failed";

export interface JobRow {
  id: number;
  source: string;
  external_id: string;
  dedupe_key: string;
  company: string;
  title: string;
  location: string;
  url: string;
  apply_url: string | null;
  ats: string | null;
  description: string;
  salary: string | null;
  posted_at: string | null;
  found_at: string;
  status: JobStatus;
  score: number | null;
  track: string | null;
  score_json: string | null;
  error: string | null;
  updated_at: string;
}

export function setStatus(id: number, status: JobStatus, error: string | null = null) {
  db.prepare("UPDATE jobs SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?").run(status, error, id);
}

export function getJob(id: number): JobRow | undefined {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
}

export function jobsWithStatus(status: JobStatus, limit = 500): JobRow[] {
  return db
    .prepare("SELECT * FROM jobs WHERE status = ? ORDER BY score DESC NULLS LAST, found_at DESC LIMIT ?")
    .all(status, limit) as JobRow[];
}
