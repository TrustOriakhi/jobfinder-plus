import { loadSettings, type Settings } from "./config.js";
import { db, type JobRow } from "./db.js";
import { dedupeKey, ruleFilter } from "./filter.js";
import { ashby, greenhouse, lever, workable } from "./sources/ats.js";
import { adzuna, linkedinDetail, linkedinSearch, reed, reedDetail, remoteok, weworkremotely } from "./sources/boards.js";
import { detectAts, sleep, type Ats, type RawJob } from "./sources/types.js";

const ATS_FETCHERS: Record<Ats, (token: string) => Promise<RawJob[]>> = { greenhouse, lever, ashby, workable };

function searchTerms(s: Settings): string[] {
  // One query per title keeps boards' relevance ranking useful.
  return [...new Set(s.targets.flatMap((t) => t.titles))];
}

async function collect(s: Settings, log: (m: string) => void): Promise<RawJob[]> {
  const jobs: RawJob[] = [];
  const run = async (label: string, fn: () => Promise<RawJob[]>) => {
    try {
      const r = await fn();
      jobs.push(...r);
      log(`${label}: ${r.length}`);
    } catch (e) {
      log(`${label}: failed (${(e as Error).message})`);
    }
  };

  const learned = db.prepare("SELECT ats, token FROM learned_boards").all() as { ats: Ats; token: string }[];
  const boards = new Map<string, { ats: Ats; token: string }>();
  for (const ats of Object.keys(ATS_FETCHERS) as Ats[]) for (const token of s.boards[ats]) boards.set(`${ats}:${token}`, { ats, token });
  for (const b of learned) boards.set(`${b.ats}:${b.token}`, b);
  for (const { ats, token } of boards.values()) await run(`${ats}/${token}`, () => ATS_FETCHERS[ats](token));

  const terms = searchTerms(s);
  for (const loc of s.locations.search) {
    for (const term of terms) {
      if (s.sources.linkedin) await run(`linkedin "${term}" ${loc}`, () => linkedinSearch(term, loc, s.pipeline.max_age_days));
      if (s.sources.reed) await run(`reed "${term}" ${loc}`, () => reed(term, loc));
      if (s.sources.adzuna) await run(`adzuna "${term}" ${loc}`, () => adzuna(term, loc, s.pipeline.max_age_days));
    }
  }
  if (s.sources.remoteok) await run("remoteok", remoteok);
  if (s.sources.weworkremotely) await run("weworkremotely", weworkremotely);
  return jobs;
}

const insert = db.prepare(`
  INSERT INTO jobs (source, external_id, dedupe_key, company, title, location, url, apply_url, ats, description, salary, posted_at, status, error)
  VALUES (@source, @external_id, @dedupe_key, @company, @title, @location, @url, @apply_url, @ats, @description, @salary, @posted_at, @status, @error)
  ON CONFLICT (source, external_id) DO NOTHING
`);

/** Re-apply the rules to stored jobs so edits to settings.yaml take effect without re-fetching. */
export function refilter(s: Settings = loadSettings()) {
  const rows = db.prepare("SELECT * FROM jobs WHERE status IN ('new', 'filtered')").all() as JobRow[];
  const set = db.prepare("UPDATE jobs SET status = ?, error = ? WHERE id = ?");
  db.transaction(() => {
    for (const j of rows) {
      const reason = ruleFilter({ ...j, apply_url: j.apply_url }, s);
      if (reason && j.status === "new") set.run("filtered", reason, j.id);
      else if (!reason && j.status === "filtered") set.run("new", null, j.id);
      else if (reason && j.error !== reason) set.run("filtered", reason, j.id);
    }
  })();
}

export async function discover(log: (m: string) => void = console.log) {
  const s = loadSettings();
  refilter(s);
  const raw = await collect(s, log);
  let added = 0;
  let passed = 0;
  const seen = new Set<string>();
  const existing = db.prepare("SELECT id, ats FROM jobs WHERE dedupe_key = ? LIMIT 1");
  const attachAts = db.prepare("UPDATE jobs SET apply_url = ?, ats = ? WHERE id = ? AND ats IS NULL");

  db.transaction(() => {
    for (const j of raw) {
      const key = dedupeKey(j.company, j.title);
      const ats = detectAts(j.apply_url ?? j.url);
      const dup = existing.get(key) as Pick<JobRow, "id" | "ats"> | undefined;
      if (dup || seen.has(key)) {
        // Same role seen on an aggregator: upgrade it with the direct ATS link.
        if (dup && ats && !dup.ats) attachAts.run(j.apply_url ?? j.url, ats.ats, dup.id);
        continue;
      }
      seen.add(key);
      const reason = ruleFilter(j, s);
      const r = insert.run({
        ...j,
        apply_url: j.apply_url ?? null,
        salary: j.salary ?? null,
        posted_at: j.posted_at ?? null,
        dedupe_key: key,
        ats: ats?.ats ?? null,
        status: reason ? "filtered" : "new",
        error: reason,
      });
      if (r.changes) {
        added++;
        if (!reason) passed++;
      }
    }
  })();
  log(`found ${raw.length}, new ${added}, passed rules ${passed}`);

  await enrich(log);
  return { found: raw.length, added, passed };
}

/** Aggregator jobs arrive without full descriptions or direct apply links: fetch them for jobs that passed rules. */
async function enrich(log: (m: string) => void) {
  const home = `%${loadSettings().locations.local[0] ?? ""}%`;
  const rows = db
    // LinkedIn throttles detail pages hard, so each run takes a capped batch: home-area and remote roles, newest first.
    // The rest are picked up by the next scheduled run (three a day).
    .prepare(
      `SELECT * FROM jobs WHERE status = 'new' AND enriched = 0 AND source IN ('linkedin', 'reed')
       ORDER BY (location LIKE ? OR location LIKE '%Remote%') DESC, found_at DESC LIMIT 45`,
    )
    .all(home) as JobRow[];
  const update = db.prepare("UPDATE jobs SET description = ?, apply_url = ?, ats = ?, error = ?, enriched = 1 WHERE id = ?");
  const learn = db.prepare("INSERT OR IGNORE INTO learned_boards (ats, token) VALUES (?, ?)");
  let n = 0;
  let strikes = 0;
  for (let i = 0; i < rows.length; i++) {
    const job = rows[i];
    try {
      const d = job.source === "linkedin" ? await linkedinDetail(job.external_id) : { ...(await reedDetail(job.external_id)), easy_apply: false };
      const ats = detectAts(d.apply_url);
      if (ats) learn.run(ats.ats, ats.token);
      update.run(d.description || job.description, d.apply_url, ats?.ats ?? null, d.easy_apply ? "linkedin easy apply" : null, job.id);
      n++;
      strikes = 0;
    } catch (e) {
      if ((e as Error).message.startsWith("429")) {
        // LinkedIn throttles bursts; back off and retry the same job, give up after a few strikes.
        if (++strikes > 3) {
          log("linkedin rate limit: resuming next run");
          break;
        }
        await sleep(30_000 * strikes);
        i--;
        continue;
      }
    }
    await sleep(job.source === "linkedin" ? 3000 + Math.random() * 3000 : 300);
  }
  if (n) log(`enriched ${n}`);
}
