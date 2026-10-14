// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => (n ?? 0).toLocaleString("en-GB");
const utc = (s) => (s ? new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z") : null);

const ICON = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  review: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  send: '<path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  ext: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  play: '<path d="M7 4.5v15l13-7.5z"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  alert: '<path d="M12 8v5M12 16.5v.01"/><circle cx="12" cy="12" r="9"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  dash: '<path d="M7 12h10"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  $("#toasts").append(t);
  setTimeout(() => t.remove(), 2000);
}

function hue(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function monogram(company, lg = false) {
  const words = String(company || "?").replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean);
  const init = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
  return `<div class="mono ${lg ? "lg" : ""}" style="--h:${hue(company)}">${esc(init)}</div>`;
}
function ring(score, lg = false) {
  if (score == null) return `<div class="ring ${lg ? "lg" : ""}"><svg viewBox="0 0 36 36"><circle class="track" cx="18" cy="18" r="15.5" fill="none" stroke-width="3"/></svg><span>–</span></div>`;
  const c = 2 * Math.PI * 15.5;
  const cls = score >= 80 ? "hi" : score >= 65 ? "mid" : "";
  return `<div class="ring ${cls} ${lg ? "lg" : ""}" title="Fit score"><svg viewBox="0 0 36 36">
    <circle class="track" cx="18" cy="18" r="15.5" fill="none" stroke-width="3"/>
    <circle class="val" cx="18" cy="18" r="15.5" fill="none" stroke-width="3" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - score / 100)}"/>
  </svg><span>${score}</span></div>`;
}
function ago(d) {
  if (!d) return "";
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
const clock = (d) => d?.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const sourceName = { linkedin: "LinkedIn", reed: "Reed", adzuna: "Adzuna", remoteok: "RemoteOK", weworkremotely: "WWR", greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", workable: "Workable" };

// ---------- state ----------
let S = { counts: {}, week: {}, warnings: [], log: [], outreach: 0 };
let reviewQueue = [];

const TRACKER = [
  ["submitted", "Applied"],
  ["manual", "Apply yourself"],
  ["needs_you", "Stuck"],
  ["approved", "Sending"],
  ["shortlisted", "Queued"],
  ["low", "Low fit"],
  ["skipped", "Skipped"],
  ["failed", "Failed"],
];
const STATUS_CHIP = {
  submitted: ["good", "Applied"],
  approved: ["", "Sending"],
  ready: ["good", "Ready"],
  manual: ["warn", "Apply yourself"],
  needs_you: ["warn", "Stuck"],
  shortlisted: ["", "Queued"],
  low: ["", "Low fit"],
  skipped: ["", "Skipped"],
  failed: ["bad", "Failed"],
  new: ["", "New"],
  filtered: ["", "Filtered"],
};

function route() {
  const [view = "today", a, b] = location.hash.slice(1).split("/");
  return { view, a, b };
}

function renderNav() {
  const { view } = route();
  const stuck = (S.counts.needs_you || 0) + (S.counts.manual || 0);
  const items = [
    ["today", "Today", "home", 0],
    ["review", "Review", "review", S.counts.ready || 0],
    ["tracker", "Tracker", "list", stuck],
    ["outreach", "Outreach", "send", S.outreach || 0],
  ];
  const active = view === "job" ? "tracker" : view;
  const html = items
    .map(([k, label, ic, n]) => `<a href="#${k}" class="${active === k ? "on" : ""}">${icon(ic)}<span>${label}</span>${n ? `<span class="badge">${n}</span>` : ""}</a>`)
    .join("");
  $("#nav").innerHTML = html;
  $("#tabbar").innerHTML = html;
  $("#railFoot").innerHTML = S.running ? `<span class="dot live"></span>Running` : S.nextRun ? `Next run ${clock(new Date(S.nextRun))}` : "";
}

function topbar(title, back) {
  $("#topbar").innerHTML = `${back ? `<a class="back" href="${back}" aria-label="Back">${icon("left")}</a>` : ""}<h1>${esc(title)}</h1>
    <button class="btn soft sm" id="runBtn" ${S.running ? "disabled" : ""}>${S.running ? `<span class="dot live"></span>Running` : `${icon("play")}Run`}</button>`;
  $("#runBtn").onclick = async () => {
    await api("/api/run", { method: "POST" });
    toast("Run started");
    await loadSummary();
    render();
  };
}

async function loadSummary() {
  S = await api("/api/summary");
  renderNav();
}

// ---------- today ----------
const SETUP = [
  [/master\.md/, "Confirm your master profile", "Fix the <b>To confirm</b> list in <code>profile/master.md</code>. Tailoring is paused until then."],
  [/CLI not logged in/, "Connect your Claude subscription", "In Terminal run <code>claude</code>, then type <code>/login</code>. No API credit needed."],
  [/ANTHROPIC/, "Add a Claude API key", "<code>ANTHROPIC_API_KEY</code> in <code>.env</code>"],
  [/LinkedIn URL/, "Add your LinkedIn URL", "<code>candidate.linkedin</code> in <code>profile/settings.yaml</code>"],
  [/Reed/, "Turn on Reed", "Free key from reed.co.uk/developers → <code>REED_API_KEY</code>"],
  [/Adzuna/, "Turn on Adzuna", "Free keys from developer.adzuna.com → <code>ADZUNA_APP_ID</code>, <code>ADZUNA_APP_KEY</code>"],
];

function viewToday() {
  topbar("Today");
  const ready = S.counts.ready || 0;
  const w = S.week || {};
  const steps = [
    ["Found", w.found],
    ["Matched rules", w.passed],
    ["Good fit", w.matched],
    ["Prepared", w.prepared],
    ["Applied", w.applied],
  ];
  const max = Math.max(1, w.found || 0);
  const width = (n) => (n ? Math.max(2, (Math.log10(n + 1) / Math.log10(max + 1)) * 100) : 0);
  const last = utc(S.lastRun?.started_at);
  const setup = S.warnings.map((wn) => SETUP.find(([re]) => re.test(wn)) ?? [null, wn, ""]);

  $("#view").innerHTML = `<div class="fade-in">
    <section class="card hero">
      <div class="count num" style="font-family:var(--serif)">${ready}</div>
      <div class="label">${ready === 1 ? "role ready to review" : "roles ready to review"}</div>
      ${ready ? `<a class="btn accent" href="#review">Start reviewing ${icon("right")}</a>` : `<span class="muted">Nothing waiting.</span>`}
      <div class="status-line">
        <span>${S.running ? `<span class="dot live"></span>Running now` : `<span class="dot"></span>Next run ${S.nextRun ? clock(new Date(S.nextRun)) : "—"}`}</span>
        ${last ? `<span>Last run ${ago(last)}</span>` : ""}
        <span>${fmt(S.appliedTotal)} applied in total</span>
      </div>
    </section>

    <div class="eyebrow">Needs you</div>
    <div class="tiles">
      <a class="card tile ${S.counts.needs_you ? "alert" : ""}" href="#tracker/needs_you"><div class="n">${S.counts.needs_you || 0}</div><div class="t">Stuck</div></a>
      <a class="card tile" href="#tracker/manual"><div class="n">${S.counts.manual || 0}</div><div class="t">Apply yourself</div></a>
      <a class="card tile" href="#outreach"><div class="n">${S.outreach || 0}</div><div class="t">To reach out</div></a>
    </div>

    <div class="eyebrow">This week</div>
    <section class="card pad funnel">
      ${steps.map(([label, n]) => `<div class="step"><span class="muted">${label}</span><div class="bar"><i style="width:${width(n)}%"></i></div><span class="n">${fmt(n)}</span></div>`).join("")}
    </section>

    ${setup.length ? `<div class="eyebrow">Setup</div><ul class="card setup">${setup.map(([, t, d]) => `<li><span class="tick"></span><div><span class="st">${t}</span><span class="muted">${d}</span></div></li>`).join("")}</ul>` : ""}

    <div class="eyebrow">Activity</div>
    <details class="card pad log"><summary>${S.log.length ? esc(S.log.at(-1)) : "No activity yet"}</summary><pre>${esc(S.log.slice().reverse().join("\n"))}</pre></details>
  </div>`;
}

// ---------- tracker ----------
async function viewTracker(status = "submitted") {
  topbar("Tracker");
  $("#view").innerHTML = `<div class="seg">${TRACKER.map(([k, l]) => `<a href="#tracker/${k}" class="${k === status ? "on" : ""}">${l}<span class="c">${S.counts[k] || 0}</span></a>`).join("")}</div>
    <div id="list"><div class="sk" style="height:220px"></div></div>`;
  $(".seg a.on")?.scrollIntoView({ inline: "center", block: "nearest" });
  const rows = await api(`/api/jobs?status=${status}`);
  $("#list").innerHTML = rows.length
    ? `<div class="card rows fade-in">${rows
        .map(
          (r) => `<a class="rowlink" href="#job/${r.id}">${monogram(r.company)}
          <div class="grow"><div class="t">${esc(r.title)}</div><div class="s">${esc(r.company)} · ${esc(r.location || "—")}${r.error && !["low", "skipped"].includes(status) ? ` · ${esc(r.error)}` : ""}</div></div>
          ${r.auto ? `<span class="chip good">1-tap</span>` : ""}${ring(r.score)}</a>`,
        )
        .join("")}</div>`
    : `<div class="empty"><div class="big">Nothing here</div></div>`;
}

// ---------- outreach ----------
async function viewOutreach() {
  topbar("Outreach");
  $("#view").innerHTML = `<div class="sk" style="height:260px"></div>`;
  const rows = await api("/api/jobs?status=outreach");
  if (!rows.length) {
    $("#view").innerHTML = `<div class="empty"><div class="big">No one to message yet</div>Drafts appear when a role is prepared.</div>`;
    return;
  }
  const details = await Promise.all(rows.map((r) => api(`/api/jobs/${r.id}`)));
  const todo = details.filter((d) => d.outreach?.status === "todo");
  const done = details.filter((d) => d.outreach?.status !== "todo");
  const card = ({ job, outreach: o }) => `<section class="card oc ${o.status !== "todo" ? "done" : ""}" data-id="${job.id}">
    <a class="head" href="#job/${job.id}" style="text-decoration:none">${monogram(job.company)}<div class="grow"><div class="t">${esc(job.company)}</div><div class="s">${esc(job.title)}</div></div>${o.status === "sent" ? `<span class="chip good">Sent</span>` : ""}</a>
    ${o.status === "todo" ? `<div class="row wrap">${o.searches.map((s) => `<a class="btn line sm" target="_blank" rel="noopener" href="${esc(s.url)}">${esc(s.who)} ${icon("ext")}</a>`).join("")}</div>
    <div class="quote">${esc(o.note)}</div>
    <div class="row"><button class="btn soft sm" data-copy="${esc(o.note)}">${icon("copy")}Copy note</button><button class="btn soft sm" data-copy="${esc(o.followup)}">Copy follow-up</button><span class="grow"></span><button class="btn accent sm" data-sent>${icon("check")}Sent</button></div>` : ""}
  </section>`;
  $("#view").innerHTML = `<div class="fade-in">${todo.map(card).join("") || `<div class="empty"><div class="big">All caught up</div></div>`}
    ${done.length ? `<div class="eyebrow">Done</div>${done.map(card).join("")}` : ""}</div>`;
  bindCopy($("#view"));
  $$("[data-sent]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.closest("[data-id]").dataset.id;
      await api(`/api/jobs/${id}/outreach/sent`, { method: "POST" });
      toast("Logged");
      await loadSummary();
      viewOutreach();
    }),
  );
}

function bindCopy(root) {
  $$("[data-copy]", root).forEach((b) =>
    b.addEventListener("click", async () => {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast("Copied");
    }),
  );
}

// ---------- job detail (review + tracker) ----------
let activeTab = "cv";

async function viewReview(id) {
  topbar("Review");
  if (!reviewQueue.length || (id && !reviewQueue.includes(Number(id)))) {
    reviewQueue = (await api("/api/jobs?status=ready")).map((r) => r.id);
  }
  if (!reviewQueue.length) {
    $("#view").innerHTML = `<div class="empty fade-in"><div class="big">Inbox zero</div>New roles land after the next run${S.nextRun ? ` at ${clock(new Date(S.nextRun))}` : ""}.</div>`;
    return;
  }
  const cur = id ? Number(id) : reviewQueue[0];
  if (!id) history.replaceState(null, "", `#review/${cur}`);
  await renderJob(cur, { mode: "review" });
}

async function viewJob(id) {
  topbar("Role", "javascript:history.back()");
  await renderJob(Number(id), { mode: "job" });
}

function fieldControl(f, i) {
  const v = f.value ?? "";
  const vals = Array.isArray(v) ? v : v ? [v] : [];
  if (f.kind === "file") return `<div class="file">${icon("file")}${f.value === "cv" ? "Tailored CV" : f.value === "cover" ? "Cover letter" : `<span class="muted">Not set</span>`}</div>`;
  if (["radio", "checkbox", "select", "combobox"].includes(f.kind) && f.options.length && f.options.length <= 7)
    return `<div class="opts" data-i="${i}" data-multi="${f.multiple ? 1 : 0}">${f.options.map((o) => `<button type="button" class="${vals.includes(o) ? "on" : ""}">${esc(o)}</button>`).join("")}</div>`;
  if (f.options.length)
    return `<select data-i="${i}"><option value=""></option>${f.options.map((o) => `<option ${vals.includes(o) ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  const text = vals.join(", ");
  if (f.kind === "textarea" || text.length > 70) return `<textarea data-i="${i}">${esc(text)}</textarea>`;
  return `<input type="text" data-i="${i}" value="${esc(text)}">`;
}

async function renderJob(id, ctx) {
  $("#view").innerHTML = `<div class="sk" style="height:180px"></div><div class="sk" style="height:420px;margin-top:14px"></div>`;
  const { job, application: a, outreach: o } = await api(`/api/jobs/${id}`);
  const sc = job.score_json || {};
  const unsupported = a?.check?.unsupported || [];
  const fields = a?.fields || [];
  const lowCount = fields.filter((f) => f.confidence === "low").length;
  const [chipCls, chipLabel] = STATUS_CHIP[job.status] || ["", job.status];
  const qi = reviewQueue.indexOf(id);

  const tabs = [
    a && ["cv", "CV"],
    a && ["letter", "Letter"],
    fields.length && ["form", "Form", lowCount],
    o && ["reach", "People"],
    ["ad", "Ad"],
  ].filter(Boolean);
  if (!tabs.some(([k]) => k === activeTab)) activeTab = tabs[0][0];

  const pager =
    ctx.mode === "review"
      ? `<div class="pager"><span class="pos num">${qi + 1} of ${reviewQueue.length}</span>
        <a class="btn soft sm icon" href="#review/${reviewQueue[qi - 1] ?? id}" aria-label="Previous" ${qi <= 0 ? 'style="opacity:.35;pointer-events:none"' : ""}>${icon("left")}</a>
        <a class="btn soft sm icon" href="#review/${reviewQueue[qi + 1] ?? id}" aria-label="Next" ${qi >= reviewQueue.length - 1 ? 'style="opacity:.35;pointer-events:none"' : ""}>${icon("right")}</a></div>
        <div class="progress"><i style="width:${((qi + 1) / reviewQueue.length) * 100}%"></i></div>`
      : "";

  const meta = [
    job.location && `<span class="chip">${esc([...new Set(job.location.split(" · "))].join(" · "))}</span>`,
    job.salary && `<span class="chip">${esc(job.salary)}</span>`,
    `<span class="chip">${esc(sourceName[job.source] || job.source)}${job.ats && job.ats !== job.source ? ` · ${esc(sourceName[job.ats] || job.ats)}` : ""}</span>`,
    ["greenhouse", "lever", "ashby", "workable"].includes(job.ats) && `<span class="chip good">1-tap apply</span>`,
    ctx.mode !== "review" && `<span class="chip ${chipCls}">${chipLabel}</span>`,
  ]
    .filter(Boolean)
    .join("");

  $("#view").innerHTML = `<div class="fade-in">${pager}
  <section class="card jobhead">
    <div class="row" style="align-items:flex-start">
      ${monogram(job.company, true)}
      <div class="grow"><div class="co">${esc(job.company)}</div><h2>${esc(job.title)}</h2></div>
      ${ring(job.score, true)}
    </div>
    <div class="chips">${meta}</div>
    ${
      sc.why?.length || sc.gaps?.length
        ? `<div class="fit">
      ${sc.why?.length ? `<div><h4>Why it fits</h4><ul class="yes">${sc.why.map((x) => `<li>${icon("check")}<span>${esc(x)}</span></li>`).join("")}</ul></div>` : ""}
      ${sc.gaps?.length ? `<div><h4>Gaps</h4><ul class="no">${sc.gaps.map((x) => `<li>${icon("dash")}<span>${esc(x)}</span></li>`).join("")}</ul></div>` : ""}
    </div>`
        : ""
    }
    ${job.status === "needs_you" && job.error ? `<div class="banner warn">${icon("alert")}<div>${esc(job.error)}</div></div>` : ""}
    ${unsupported.length ? `<div class="banner bad">${icon("alert")}<div><b>Fact-check flagged ${unsupported.length}</b><ul>${unsupported.map((u) => `<li>${esc(u.claim)}: ${esc(u.problem)}</li>`).join("")}</ul></div></div>` : ""}
  </section>

  <div class="tabs" role="tablist">${tabs.map(([k, l, n]) => `<button data-tab="${k}" class="${k === activeTab ? "on" : ""}">${l}${n ? `<span class="dotw"></span>` : ""}</button>`).join("")}</div>
  <div id="pane"></div>
  ${actionBar(job, a, ctx)}
  </div>`;

  const panes = {
    cv: () => {
      const cv = a.cv || {};
      $("#pane").innerHTML = `<div class="paper-frame" id="paper"><iframe src="/api/jobs/${id}/cv.html" title="CV preview" scrolling="no"></iframe></div>
        <div class="kw">${(cv.keywords_matched || []).map((k) => `<span class="chip good">${esc(k)}</span>`).join("")}${(cv.keywords_missing || []).map((k) => `<span class="chip">${esc(k)}</span>`).join("")}</div>
        <div class="row" style="margin-top:12px"><a class="btn soft sm" target="_blank" href="/api/jobs/${id}/file/cv">${icon("file")}CV PDF</a>${a.has_cover_pdf ? `<a class="btn soft sm" target="_blank" href="/api/jobs/${id}/file/cover">${icon("file")}Letter PDF</a>` : ""}</div>`;
      const frame = $("#paper iframe");
      const fit = () => {
        const box = $("#paper");
        if (!box) return;
        const scale = box.clientWidth / 794;
        let h = 1123;
        try {
          h = Math.max(1123, frame.contentDocument.documentElement.scrollHeight);
          frame.style.height = `${h}px`;
        } catch {}
        frame.style.transform = `scale(${scale})`;
        box.style.height = `${h * scale}px`;
      };
      frame.addEventListener("load", fit);
      fit();
      window.onresize = fit;
    },
    letter: () => {
      $("#pane").innerHTML = `<textarea class="letter" id="letter">${esc(a.cover_letter)}</textarea><div class="saved" id="saved"></div>`;
      let t;
      const save = async () => {
        await api(`/api/jobs/${id}/letter`, { method: "PATCH", body: { cover_letter: $("#letter").value } });
        $("#saved").textContent = "Saved";
      };
      $("#letter").addEventListener("input", () => {
        $("#saved").textContent = "";
        clearTimeout(t);
        t = setTimeout(save, 1200);
      });
    },
    form: () => {
      const order = fields.map((f, i) => i).sort((x, y) => (fields[y].confidence === "low") - (fields[x].confidence === "low"));
      $("#pane").innerHTML = `${lowCount ? `<div class="banner warn" style="margin:0 0 12px">${icon("alert")}<div>${lowCount} answer${lowCount > 1 ? "s" : ""} to check</div></div>` : ""}
        <div class="card fields">${order
          .map((i) => [fields[i], i])
          .map(
            ([f, i]) => `<div class="f ${f.confidence === "low" ? "low" : ""}"><label><span>${esc(f.kind === "file" ? (f.value === "cover" ? "Cover letter" : f.value === "cv" ? "CV" : f.label) : f.label || f.key)}${f.required ? ` <span class="req">*</span>` : ""}</span><span class="src">${f.source === "ai" ? "drafted" : f.source === "you" ? "you" : f.source === "profile" ? "profile" : ""}</span></label>
          ${fieldControl(f, i)}${f.note ? `<div class="note">${esc(f.note)}</div>` : ""}</div>`,
          )
          .join("")}</div>`;
      const save = async (i, value) => {
        fields[i].value = value;
        fields[i].confidence = "high";
        await api(`/api/jobs/${id}/fields`, { method: "PATCH", body: { fields: [{ key: fields[i].key, value }] } });
        const box = $(`[data-i="${i}"]`).closest(".f");
        box.classList.remove("low");
        $(".note", box)?.remove();
      };
      $$("#pane .opts").forEach((g) =>
        g.addEventListener("click", (e) => {
          const b = e.target.closest("button");
          if (!b) return;
          const multi = g.dataset.multi === "1";
          if (!multi) $$("button", g).forEach((x) => x.classList.toggle("on", x === b));
          else b.classList.toggle("on");
          const on = $$("button.on", g).map((x) => x.textContent);
          save(Number(g.dataset.i), multi ? on : on[0] ?? "");
        }),
      );
      $$("#pane input[data-i], #pane textarea[data-i], #pane select[data-i]").forEach((el) =>
        el.addEventListener("change", () => save(Number(el.dataset.i), el.value)),
      );
    },
    reach: () => {
      $("#pane").innerHTML = `<div class="people">${o.searches.map((s) => `<a class="person" target="_blank" rel="noopener" href="${esc(s.url)}">${icon("user")}<span>${esc(s.who)} at ${esc(job.company)}</span>${icon("ext")}</a>`).join("")}</div>
        <div class="eyebrow">Connection note <span class="charcount">${o.note.length}/300</span></div><div class="quote">${esc(o.note)}</div>
        <div class="row" style="margin-top:8px"><button class="btn soft sm" data-copy="${esc(o.note)}">${icon("copy")}Copy</button></div>
        <div class="eyebrow">Once they accept</div><div class="quote">${esc(o.followup)}</div>
        <div class="row" style="margin-top:8px"><button class="btn soft sm" data-copy="${esc(o.followup)}">${icon("copy")}Copy</button>
        <span class="grow"></span>${o.status === "todo" ? `<button class="btn accent sm" id="sent">${icon("check")}Mark sent</button>` : `<span class="chip good">Sent</span>`}</div>`;
      bindCopy($("#pane"));
      $("#sent")?.addEventListener("click", async () => {
        await api(`/api/jobs/${id}/outreach/sent`, { method: "POST" });
        o.status = "sent";
        toast("Logged");
        loadSummary();
        panes.reach();
      });
    },
    ad: () => {
      $("#pane").innerHTML = `<div class="card pad" style="white-space:pre-wrap;font-size:14px;line-height:1.6">${esc(job.description || "No description captured.")}</div>
        <div class="row" style="margin-top:12px"><a class="btn soft sm" target="_blank" rel="noopener" href="${esc(job.url)}">Original ad ${icon("ext")}</a></div>`;
    },
  };
  const showTab = (k) => {
    activeTab = k;
    $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === k));
    panes[k]();
  };
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  showTab(activeTab);
  bindActions(job, ctx, lowCount);
}

function actionBar(job, a, ctx) {
  const more = (items) =>
    items.length
      ? `<div class="menu"><button class="btn soft icon" data-act="menu" aria-label="More">${icon("more")}</button><div class="menu-pop">${items.join("")}</div></div>`
      : "";
  const applyLink = job.apply_url || job.url;
  switch (job.status) {
    case "ready":
      return `<div class="actionbar"><button class="btn soft icon" data-act="skip" aria-label="Skip" title="Skip (S)">${icon("x")}</button>
        <button class="btn accent" data-act="approve">${icon("check")}Approve & submit<span class="kbd">A</span></button>
        ${more([`<button data-act="assist">Fill on Mac instead</button>`, `<button data-act="applied">I applied myself</button>`, `<a href="${esc(job.url)}" target="_blank" rel="noopener">Open job ad</a>`])}</div>`;
    case "needs_you":
      return `<div class="actionbar"><button class="btn line" data-act="assist">Fill on Mac</button>
        <button class="btn accent" data-act="applied">${icon("check")}Mark applied</button>
        ${more([`<a href="${esc(applyLink)}" target="_blank" rel="noopener">Open application</a>`, `<button data-act="approve">Retry auto-submit</button>`, `<button class="bad" data-act="skip">Skip</button>`])}</div>`;
    case "manual":
      return `<div class="actionbar"><button class="btn line" data-act="assist">Fill on Mac</button>
        <button class="btn accent" data-act="applied">${icon("check")}Mark applied</button>
        ${more([`<a href="${esc(applyLink)}" target="_blank" rel="noopener">Open application</a>`, `<button class="bad" data-act="skip">Skip</button>`])}</div>`;
    case "shortlisted":
    case "low":
    case "failed":
    case "new":
      return `<div class="actionbar"><button class="btn accent" data-act="prepare">Prepare application</button>${more([`<button class="bad" data-act="skip">Skip</button>`])}</div>`;
    default:
      return "";
  }
}

function bindActions(job, ctx, lowCount) {
  const next = () => {
    if (ctx.mode === "review") {
      const i = reviewQueue.indexOf(job.id);
      reviewQueue.splice(i, 1);
      location.hash = reviewQueue.length ? `#review/${reviewQueue[Math.min(i, reviewQueue.length - 1)]}` : "#review";
    } else render();
  };
  const post = async (path, msg) => {
    try {
      await api(path, { method: "POST" });
      toast(msg);
      await loadSummary();
      next();
    } catch (e) {
      toast(e.message);
    }
  };
  const acts = {
    approve: () => {
      if (lowCount && !confirm(`${lowCount} answer${lowCount > 1 ? "s" : ""} still flagged. Submit anyway?`)) return;
      post(`/api/jobs/${job.id}/approve`, "Submitting");
    },
    skip: () => post(`/api/jobs/${job.id}/skip`, "Skipped"),
    applied: () => post(`/api/jobs/${job.id}/applied`, "Marked applied"),
    prepare: async (btn) => {
      btn.disabled = true;
      btn.textContent = "Preparing…";
      try {
        await api(`/api/jobs/${job.id}/prepare`, { method: "POST" });
        toast("Ready to review");
        await loadSummary();
        render();
      } catch (e) {
        toast(e.message);
        btn.disabled = false;
        btn.textContent = "Prepare application";
      }
    },
    assist: async (btn) => {
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Filling…";
      try {
        const r = await api(`/api/jobs/${job.id}/assist`, { method: "POST" });
        toast(r.filled ? `Filled ${r.filled} fields on your Mac` : r.note || "Opened on your Mac");
        if (r.skipped?.length) toast(`Check: ${r.skipped.slice(0, 2).join(", ")}`);
        btn.textContent = "Fill this page";
      } catch (e) {
        toast(e.message);
        btn.textContent = label;
      }
      btn.disabled = false;
    },
    menu: (btn) => btn.closest(".menu").classList.toggle("open"),
  };
  $$("[data-act]").forEach((b) => b.addEventListener("click", (e) => acts[b.dataset.act]?.(b, e)));
  document.onclick = (e) => {
    if (!e.target.closest(".menu")) $$(".menu.open").forEach((m) => m.classList.remove("open"));
  };
  document.onkeydown =
    ctx.mode === "review"
      ? (e) => {
          if (e.target.closest("input, textarea, select") || e.metaKey || e.ctrlKey) return;
          const i = reviewQueue.indexOf(job.id);
          if (e.key === "ArrowRight" || e.key === "j") reviewQueue[i + 1] && (location.hash = `#review/${reviewQueue[i + 1]}`);
          if (e.key === "ArrowLeft" || e.key === "k") reviewQueue[i - 1] && (location.hash = `#review/${reviewQueue[i - 1]}`);
          if (e.key === "a") acts.approve();
          if (e.key === "s") acts.skip();
        }
      : null;
}

// ---------- router ----------
async function render() {
  const { view, a } = route();
  renderNav();
  window.onresize = null;
  document.onkeydown = null;
  try {
    if (view === "review") await viewReview(a);
    else if (view === "tracker") await viewTracker(a);
    else if (view === "outreach") await viewOutreach();
    else if (view === "job") await viewJob(a);
    else viewToday();
  } catch (e) {
    $("#view").innerHTML = `<div class="empty"><div class="big">Something broke</div>${esc(e.message)}</div>`;
  }
  if (!location.hash.includes("/")) window.scrollTo(0, 0);
}

window.addEventListener("hashchange", render);
loadSummary().then(render);
setInterval(async () => {
  const wasRunning = S.running;
  await loadSummary();
  if (route().view === "today" || (wasRunning && !S.running)) render();
}, 15000);
