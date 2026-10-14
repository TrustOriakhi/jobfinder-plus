import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { env } from "../config.js";
import { getJson, getText, htmlToText, sleep, type RawJob } from "./types.js";

// ---------- LinkedIn (public guest endpoints, no login) ----------

const LI = "https://www.linkedin.com/jobs-guest/jobs/api";

export async function linkedinSearch(keywords: string, location: string, maxAgeDays: number): Promise<RawJob[]> {
  const seconds = Math.max(1, maxAgeDays) * 86400;
  const out: RawJob[] = [];
  for (let start = 0; start < 75; start += 25) {
    const q = new URLSearchParams({ keywords, location, f_TPR: `r${seconds}`, start: String(start) });
    const remote = /remote/i.test(location);
    if (remote) q.set("f_WT", "2");
    let html: string;
    try {
      html = await getText(`${LI}/seeMoreJobPostings/search?${q}`);
    } catch {
      break;
    }
    const $ = cheerio.load(html);
    const cards = $("div.base-card");
    if (!cards.length) break;
    cards.each((_, el) => {
      const c = $(el);
      const id = c.attr("data-entity-urn")?.split(":").pop();
      if (!id) return;
      out.push({
        source: "linkedin",
        external_id: id,
        company: c.find(".base-search-card__subtitle").text().trim(),
        title: c.find(".base-search-card__title").text().trim(),
        location: c.find(".job-search-card__location").text().trim() + (remote ? " · Remote" : ""),
        url: `https://www.linkedin.com/jobs/view/${id}/`,
        description: "",
        salary: c.find(".job-search-card__salary-info").text().trim() || null,
        posted_at: c.find("time").attr("datetime") ?? null,
      });
    });
    await sleep(1500);
  }
  return out;
}

/** Fills in description + external apply link. LinkedIn rate-limits this hard, so callers pace it. */
export async function linkedinDetail(id: string): Promise<{ description: string; apply_url: string | null; easy_apply: boolean }> {
  const html = await getText(`${LI}/jobPosting/${id}`);
  const $ = cheerio.load(html);
  const description = htmlToText($(".description__text").html() ?? "");
  const criteria = $(".description__job-criteria-item")
    .map((_, el) => `${$(el).find("h3").text().trim()}: ${$(el).find("span").text().trim()}`)
    .get()
    .join("\n");
  let apply_url: string | null = null;
  const code = html.match(/<code id="applyUrl"[^>]*><!--"(.*?)"--><\/code>/);
  if (code) {
    try {
      const u = new URL(code[1].replace(/&amp;/g, "&"));
      apply_url = u.searchParams.get("url") ?? u.toString();
    } catch {
      /* ignore */
    }
  }
  const easy_apply = !apply_url && html.includes("apply-link-simple_onsite");
  return { description: [description, criteria].filter(Boolean).join("\n\n"), apply_url, easy_apply };
}

// ---------- Reed (official API) ----------

export async function reed(keywords: string, location: string): Promise<RawJob[]> {
  if (!env.reedKey) return [];
  const auth = { authorization: "Basic " + Buffer.from(`${env.reedKey}:`).toString("base64") };
  const q = new URLSearchParams({ keywords, resultsToTake: "100" });
  if (/remote/i.test(location)) q.set("keywords", `${keywords} remote`);
  else q.set("locationName", location), q.set("distanceFromLocation", "20");
  const data = await getJson(`https://www.reed.co.uk/api/1.0/search?${q}`, { headers: auth });
  return (data.results ?? []).map((j: any) => ({
    source: "reed",
    external_id: String(j.jobId),
    company: j.employerName,
    title: j.jobTitle,
    location: j.locationName ?? "",
    url: j.jobUrl,
    description: j.jobDescription ?? "",
    salary: j.minimumSalary ? `£${j.minimumSalary}–£${j.maximumSalary ?? j.minimumSalary}` : null,
    posted_at: j.date ? j.date.split("/").reverse().join("-") : null,
  }));
}

export async function reedDetail(id: string): Promise<{ description: string; apply_url: string | null }> {
  const auth = { authorization: "Basic " + Buffer.from(`${env.reedKey}:`).toString("base64") };
  const j = await getJson(`https://www.reed.co.uk/api/1.0/jobs/${id}`, { headers: auth });
  return { description: htmlToText(j.jobDescription ?? ""), apply_url: j.externalUrl || null };
}

// ---------- Adzuna (aggregator: Indeed-style UK listings) ----------

export async function adzuna(keywords: string, location: string, maxAgeDays: number): Promise<RawJob[]> {
  if (!env.adzunaId || !env.adzunaKey) return [];
  const q = new URLSearchParams({
    app_id: env.adzunaId,
    app_key: env.adzunaKey,
    what: keywords,
    results_per_page: "50",
    max_days_old: String(maxAgeDays),
    "content-type": "application/json",
  });
  if (/remote/i.test(location)) q.set("what", `${keywords} remote`);
  else q.set("where", location), q.set("distance", "30");
  const data = await getJson(`https://api.adzuna.com/v1/api/jobs/gb/search/1?${q}`);
  return (data.results ?? []).map((j: any) => ({
    source: "adzuna",
    external_id: String(j.id),
    company: j.company?.display_name ?? "",
    title: htmlToText(j.title ?? ""),
    location: j.location?.display_name ?? "",
    url: j.redirect_url,
    description: htmlToText(j.description ?? ""),
    salary: j.salary_min ? `£${Math.round(j.salary_min)}–£${Math.round(j.salary_max ?? j.salary_min)}` : null,
    posted_at: j.created ?? null,
  }));
}

// ---------- Remote boards ----------

export async function remoteok(): Promise<RawJob[]> {
  const data = await getJson<any[]>("https://remoteok.com/api");
  return data
    .filter((j) => j.id && j.position)
    .map((j) => ({
      source: "remoteok",
      external_id: String(j.id),
      company: j.company,
      title: j.position,
      location: j.location || "Remote",
      url: j.url,
      apply_url: j.apply_url || null,
      description: htmlToText(j.description ?? "") + (j.tags?.length ? `\nTags: ${j.tags.join(", ")}` : ""),
      salary: j.salary_min ? `$${j.salary_min}–$${j.salary_max}` : null,
      posted_at: j.date ?? null,
    }));
}

const WWR_FEEDS = [
  "https://weworkremotely.com/categories/remote-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss",
  "https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss",
  "https://weworkremotely.com/categories/remote-customer-support-jobs.rss",
];

export async function weworkremotely(): Promise<RawJob[]> {
  const parser = new XMLParser();
  const out: RawJob[] = [];
  for (const feed of WWR_FEEDS) {
    try {
      const xml = parser.parse(await getText(feed));
      const items = [xml.rss?.channel?.item ?? []].flat();
      for (const it of items) {
        const [company, ...rest] = String(it.title ?? "").split(":");
        out.push({
          source: "weworkremotely",
          external_id: String(it.guid ?? it.link),
          company: company.trim(),
          title: rest.join(":").trim() || company.trim(),
          location: String(it.region ?? "Remote"),
          url: it.link,
          apply_url: it.link,
          description: htmlToText(String(it.description ?? "")),
          posted_at: it.pubDate ? new Date(it.pubDate).toISOString() : null,
        });
      }
    } catch (e) {
      console.warn(`wwr ${feed}: ${(e as Error).message}`);
    }
  }
  return out;
}
