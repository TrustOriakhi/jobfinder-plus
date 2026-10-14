import { decodeEntities, getJson, htmlToText, prettyToken, type RawJob } from "./types.js";

export async function greenhouse(token: string): Promise<RawJob[]> {
  const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
  return (data.jobs ?? []).map((j: any) => ({
    source: "greenhouse",
    external_id: `${token}:${j.id}`,
    company: j.company_name ?? token,
    title: j.title,
    location: j.location?.name ?? "",
    url: j.absolute_url,
    apply_url: j.absolute_url,
    description: htmlToText(decodeEntities(j.content ?? "")),
    posted_at: j.first_published ?? j.updated_at ?? null,
  }));
}

export async function lever(token: string): Promise<RawJob[]> {
  let data: any[];
  try {
    data = await getJson(`https://api.lever.co/v0/postings/${token}?mode=json`);
  } catch {
    data = await getJson(`https://api.eu.lever.co/v0/postings/${token}?mode=json`);
  }
  return data.map((j: any) => ({
    source: "lever",
    external_id: `${token}:${j.id}`,
    company: prettyToken(token),
    title: j.text,
    location: [j.categories?.location, j.workplaceType].filter(Boolean).join(" · "),
    url: j.hostedUrl,
    apply_url: j.applyUrl ?? `${j.hostedUrl}/apply`,
    description: [j.descriptionPlain, ...(j.lists ?? []).map((l: any) => `${l.text}\n${htmlToText(l.content)}`), j.additionalPlain]
      .filter(Boolean)
      .join("\n\n"),
    salary: j.salaryRange ? `${j.salaryRange.currency} ${j.salaryRange.min}–${j.salaryRange.max}` : null,
    posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
  }));
}

export async function ashby(token: string): Promise<RawJob[]> {
  const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`);
  return (data.jobs ?? [])
    .filter((j: any) => j.isListed !== false)
    .map((j: any) => ({
      source: "ashby",
      external_id: `${token}:${j.id}`,
      company: prettyToken(token),
      title: j.title,
      location: [...new Set([j.location, j.isRemote ? "Remote" : null, j.workplaceType].filter(Boolean))].join(" · "),
      url: j.jobUrl,
      apply_url: j.applyUrl ?? `${j.jobUrl}/application`,
      description: j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? ""),
      salary: j.compensation?.compensationTierSummary ?? null,
      posted_at: j.publishedAt ?? null,
    }));
}

export async function workable(token: string): Promise<RawJob[]> {
  const data = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`);
  return (data.jobs ?? []).map((j: any) => ({
    source: "workable",
    external_id: `${token}:${j.shortcode}`,
    company: data.name ?? token,
    title: j.title,
    location: [j.city, j.country, j.telecommuting ? "Remote" : null].filter(Boolean).join(", "),
    url: j.shortlink ?? j.url,
    apply_url: j.application_url ?? `https://apply.workable.com/${token}/j/${j.shortcode}/apply/`,
    description: htmlToText(j.description ?? ""),
    posted_at: j.published_on ?? j.created_at ?? null,
  }));
}
