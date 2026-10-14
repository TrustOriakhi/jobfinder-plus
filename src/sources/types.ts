import * as cheerio from "cheerio";

export interface RawJob {
  source: string;
  external_id: string;
  company: string;
  title: string;
  location: string;
  url: string;
  apply_url?: string | null;
  description: string;
  salary?: string | null;
  posted_at?: string | null;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

export async function getText(url: string, init: RequestInit = {}): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: { "user-agent": UA, accept: "*/*", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

export async function getJson<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  return JSON.parse(await getText(url, { ...init, headers: { accept: "application/json", ...(init.headers ?? {}) } }));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("br").replaceWith("\n");
  $("p, li, h1, h2, h3, h4, div").each((_, el) => {
    $(el).append("\n");
  });
  $("li").each((_, el) => {
    $(el).prepend("• ");
  });
  return $.root()
    .text()
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Decode HTML entities that APIs (e.g. Greenhouse) return inside JSON strings. */
export function decodeEntities(s: string): string {
  return cheerio.load(`<x>${s}</x>`)("x").text();
}

export type Ats = "greenhouse" | "lever" | "ashby" | "workable";

/** Recognise ATS-hosted apply links so we can auto-fill them and poll the company's whole board. */
export function detectAts(url: string | null | undefined): { ats: Ats; token: string } | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const parts = u.pathname.split("/").filter(Boolean);
  const h = u.hostname;
  if (h.endsWith("greenhouse.io")) {
    const token = u.searchParams.get("for") ?? parts[0];
    return token ? { ats: "greenhouse", token } : null;
  }
  if (h === "jobs.lever.co" || h === "jobs.eu.lever.co") return parts[0] ? { ats: "lever", token: parts[0] } : null;
  if (h === "jobs.ashbyhq.com") return parts[0] ? { ats: "ashby", token: parts[0] } : null;
  if (h === "apply.workable.com") return parts[0] ? { ats: "workable", token: parts[0] } : null;
  return null;
}

/** Board tokens like "eleven-labs" → "Eleven Labs" when the API gives no company name. */
export function prettyToken(token: string): string {
  return token.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
