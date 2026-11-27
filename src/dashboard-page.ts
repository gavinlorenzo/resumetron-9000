// The dashboard's page and script. Plain DOM, no build step, no outside requests: everything is
// served by src/dashboard.ts from the same origin, and every value is inserted as text.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Job search</title>
<style>
:root {
  --bg: #f6f4ef; --panel: #ffffff; --ink: #1d1c1a; --muted: #6b675f; --line: #e4e0d6;
  --accent: #2f5d50; --accent-soft: #e3eee9;
  --ok: #2f6b3a; --ok-soft: #e2f0e2; --warn: #8a5a00; --warn-soft: #fbf0d9;
  --bad: #9b2c2c; --bad-soft: #f8e3e1; --info: #2b4f86; --info-soft: #e2eaf7; --idle: #5f5f5f; --idle-soft: #ececec;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161614; --panel: #1f1f1c; --ink: #ecebe6; --muted: #a29e94; --line: #34332e;
    --accent: #8cc7b5; --accent-soft: #23352f;
    --ok: #9ad3a2; --ok-soft: #1f3322; --warn: #f0c46a; --warn-soft: #3a2f17;
    --bad: #f2a29b; --bad-soft: #3d2120; --info: #a9c3ef; --info-soft: #1f2a3d; --idle: #bdbdbd; --idle-soft: #2c2c2a;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color: var(--accent); }
.wrap { max-width: 1040px; margin: 0 auto; padding: 20px 16px 64px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 16px; margin-bottom: 18px; }
h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 13px; }
.tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.tile b { display: block; font-size: 26px; font-variant-numeric: tabular-nums; line-height: 1.1; }
.tile span { color: var(--muted); font-size: 13px; }
.quota { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; margin-bottom: 18px; font-size: 13px; color: var(--muted); }
.bar { height: 6px; background: var(--line); border-radius: 3px; margin-top: 6px; overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--accent); }
nav { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 14px; overflow-x: auto; }
nav button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 9px 12px; font: inherit; color: var(--muted); cursor: pointer; white-space: nowrap; }
nav button[aria-selected="true"] { color: var(--ink); border-color: var(--accent); font-weight: 600; }
.tools { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.tools input { flex: 1 1 200px; min-width: 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink); font: inherit; }
.chip { border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 999px; padding: 6px 11px; font: inherit; font-size: 13px; cursor: pointer; }
.chip[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); }
.list { display: grid; gap: 8px; }
.row { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 11px 14px; cursor: pointer; text-align: left; font: inherit; color: inherit; width: 100%; }
.row:hover, .row:focus-visible { border-color: var(--accent); outline: none; }
.row .t { font-weight: 600; }
.row .c { color: var(--muted); font-size: 13px; }
.row .r { grid-column: 1 / -1; color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.meta { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.pill { display: inline-block; border-radius: 999px; padding: 2px 9px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.s-submitted { background: var(--ok-soft); color: var(--ok); }
.s-unconfirmed, .s-ready { background: var(--info-soft); color: var(--info); }
.s-needs_human { background: var(--warn-soft); color: var(--warn); }
.s-failed, .s-rejected { background: var(--bad-soft); color: var(--bad); }
.s-skipped { background: var(--idle-soft); color: var(--idle); }
.o-interview, .o-offer { background: var(--ok-soft); color: var(--ok); }
.o-rejected { background: var(--bad-soft); color: var(--bad); }
.o-acknowledged { background: var(--idle-soft); color: var(--idle); }
.fit { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.empty { color: var(--muted); padding: 28px 4px; text-align: center; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin-bottom: 10px; }
.card h3 { margin: 0 0 4px; font-size: 15px; }
.feed { display: grid; gap: 6px; }
.feed div { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; font-size: 14px; }
.feed time { display: block; color: var(--muted); font-size: 12px; }
dialog { width: min(820px, 100vw); max-height: 100dvh; margin: auto; padding: 0; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); color: var(--ink); }
dialog::backdrop { background: rgba(0,0,0,.45); }
.dh { position: sticky; top: 0; background: var(--panel); border-bottom: 1px solid var(--line); padding: 14px 16px; display: flex; gap: 12px; justify-content: space-between; align-items: flex-start; }
.dh h2 { margin: 0; font-size: 18px; }
.db { padding: 14px 16px 22px; }
.close { background: none; border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px; font: inherit; cursor: pointer; color: var(--ink); }
.sec { margin-top: 16px; }
.sec h4 { margin: 0 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.sec ul { margin: 0; padding-left: 18px; }
.factor { display: grid; grid-template-columns: 130px 1fr 34px; gap: 8px; align-items: center; font-size: 13px; margin: 3px 0; }
.factor .bar { margin: 0; }
.docs { display: flex; flex-wrap: wrap; gap: 8px; }
.btn { display: inline-block; border: 1px solid var(--accent); color: var(--accent); background: var(--accent-soft); border-radius: 8px; padding: 7px 12px; text-decoration: none; font-size: 14px; }
iframe.pdf { width: 100%; height: 70vh; border: 1px solid var(--line); border-radius: 8px; margin-top: 10px; background: #fff; }
details summary { cursor: pointer; color: var(--accent); }
pre.desc { white-space: pre-wrap; font: inherit; font-size: 14px; margin: 8px 0 0; max-height: 50vh; overflow: auto; }
.note { color: var(--muted); font-size: 13px; }
@media (max-width: 640px) {
  .tiles { grid-template-columns: repeat(2, 1fr); }
  .factor { grid-template-columns: 100px 1fr 30px; }
  iframe.pdf { display: none; }
  dialog { border-radius: 0; height: 100dvh; }
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1 id="title">Job search</h1>
    <span class="sub" id="updated"></span>
  </header>
  <section class="tiles" id="tiles"></section>
  <div class="quota" id="quota"></div>
  <nav role="tablist" id="tabs"></nav>
  <main id="view"></main>
</div>
<dialog id="detail" aria-labelledby="dtitle"></dialog>
<script src="/app.js"></script>
</body>
</html>`;

export const DASHBOARD_JS = String.raw`"use strict";
const STATUS = {
  submitted: "Submitted",
  unconfirmed: "Sent, unconfirmed",
  ready: "Ready to send",
  needs_human: "Needs a person",
  failed: "Site rejected it",
  skipped: "Skipped",
  rejected: "Screened out",
};
const STATUS_HELP = {
  submitted: "The employer's site confirmed the application.",
  unconfirmed: "Sent, but the site showed no confirmation page.",
  ready: "Prepared and waiting for approval.",
  needs_human: "Prepared, but a question or step needs a person: use the documents and posting link below to finish it.",
  failed: "The site refused the submission.",
  skipped: "Passed on.",
};
const OUTCOME = { acknowledged: "Acknowledged", rejected: "Employer declined", interview: "Interview", offer: "Offer" };
const FACTOR = { requirements: "Requirements", experience: "Experience", education: "Education", domain: "Field", goals: "Goals" };

const state = { tab: "applications", filter: "all", q: "", apps: [], screened: null, activity: null, summary: null };

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const api = (p) => fetch(p, { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error(r.status + " " + p); return r.json(); });
function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return "today " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "yesterday";
  if (days < 7) return days + " days ago";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
const pill = (status) => h("span", { class: "pill s-" + status }, STATUS[status] || status);
const outcomePill = (o) => (o ? h("span", { class: "pill o-" + o }, OUTCOME[o] || o) : null);
const n = (x) => x || 0;

function renderSummary(s) {
  document.getElementById("title").textContent = s.name ? s.name + "'s job search" : "Job search";
  document.title = s.name ? s.name + " · job search" : "Job search";
  document.getElementById("updated").textContent =
    (s.lastRun ? "Last run " + when(s.lastRun) : "No runs yet") + " · " + (s.submitMode === "auto" ? "submits automatically" : "waits for approval");
  const c = s.counts;
  const sent = n(c.submitted) + n(c.unconfirmed);
  const waiting = n(c.needs_human) + n(c.ready);
  const interviews = n(s.outcomes.interview) + n(s.outcomes.offer);
  const screened = Object.entries(c).filter(([k]) => k !== "discovered").reduce((a, [, v]) => a + v, 0);
  const tiles = [[sent, "Submitted"], [waiting, "Need a person"], [interviews, "Interviews"], [screened, "Jobs reviewed"]];
  document.getElementById("tiles").replaceChildren(...tiles.map(([v, l]) => h("div", { class: "tile" }, h("b", {}, v), h("span", {}, l))));
  const pct = Math.min(100, Math.round((100 * s.quota.today) / Math.max(1, s.quota.maxPerDay)));
  document.getElementById("quota").replaceChildren(
    "Applications prepared in the last 24 hours: " + s.quota.today + " of " + s.quota.maxPerDay + " a day",
    h("div", { class: "bar" }, h("i", { style: "width:" + pct + "%" })),
  );
}

function renderTabs() {
  const tabs = [["applications", "Applications"], ["screened", "Screened out"], ["strategy", "Strategy"], ["activity", "Activity"]];
  document.getElementById("tabs").replaceChildren(
    ...tabs.map(([id, label]) =>
      h("button", { role: "tab", "aria-selected": state.tab === id ? "true" : "false", onclick: () => { state.tab = id; renderTabs(); renderView(); } }, label),
    ),
  );
}

function matches(r) {
  if (!state.q) return true;
  const q = state.q.toLowerCase();
  return [r.company, r.title, r.location, r.track, r.reason].some((v) => v && v.toLowerCase().includes(q));
}

function appRow(r) {
  return h("button", { class: "row", onclick: () => openJob(r.id) },
    h("div", {}, h("div", { class: "t" }, r.title), h("div", { class: "c" }, [r.company, r.location].filter(Boolean).join(" · "))),
    h("div", { class: "meta" }, pill(r.status), outcomePill(r.outcome), h("span", { class: "fit" }, (r.fit != null ? "fit " + r.fit + " · " : "") + when(r.submitted_at || r.prepared_at || r.updated_at))),
  );
}

function renderApplications(view) {
  const groups = [["all", "All"], ["submitted", "Submitted"], ["waiting", "Need a person"], ["replies", "Replies"], ["skipped", "Skipped"]];
  const inGroup = (r) =>
    state.filter === "all" ||
    (state.filter === "submitted" && (r.status === "submitted" || r.status === "unconfirmed")) ||
    (state.filter === "waiting" && (r.status === "needs_human" || r.status === "ready")) ||
    (state.filter === "replies" && r.outcome) ||
    (state.filter === "skipped" && (r.status === "skipped" || r.status === "failed"));
  const rows = state.apps.filter((r) => inGroup(r) && matches(r));
  const search = h("input", { type: "search", placeholder: "Search company, title, place", value: state.q, "aria-label": "Search",
    oninput: (e) => { state.q = e.target.value; const l = document.getElementById("rows"); l.replaceChildren(...listOf(state.apps.filter((r) => inGroup(r) && matches(r)))); } });
  const listOf = (rs) => (rs.length ? rs.map(appRow) : [h("div", { class: "empty" }, state.apps.length ? "Nothing matches." : "No applications yet. The next run will add some.")]);
  view.replaceChildren(
    h("div", { class: "tools" }, search,
      ...groups.map(([id, label]) => h("button", { class: "chip", "aria-pressed": state.filter === id ? "true" : "false", onclick: () => { state.filter = id; renderView(); } }, label))),
    h("div", { class: "list", id: "rows" }, ...listOf(rows)),
  );
}

async function renderScreened(view) {
  if (!state.screened) {
    view.replaceChildren(h("div", { class: "empty" }, "Loading…"));
    state.screened = await api("/api/screened");
  }
  const rows = state.screened.filter(matches);
  const search = h("input", { type: "search", placeholder: "Search", value: state.q, "aria-label": "Search", oninput: (e) => { state.q = e.target.value; renderScreened(view); } });
  view.replaceChildren(
    h("p", { class: "note" }, "Postings the search found and turned down, with the reason. The most recent 300."),
    h("div", { class: "tools" }, search),
    h("div", { class: "list" }, ...(rows.length ? rows.map((r) =>
      h("div", { class: "row", style: "cursor:default" },
        h("div", {}, h("div", { class: "t" }, r.title), h("div", { class: "c" }, [r.company, r.location].filter(Boolean).join(" · "))),
        h("div", { class: "meta" }, h("span", { class: "fit" }, (r.fit != null ? "fit " + r.fit + " · " : "") + when(r.at))),
        h("div", { class: "r" }, r.reason || ""),
      )) : [h("div", { class: "empty" }, "Nothing screened out yet.")])),
  );
}

function renderStrategy(view) {
  const tracks = (state.summary && state.summary.tracks) || [];
  view.replaceChildren(
    h("p", { class: "note" }, "Each track is a bet about where interviews will come from. Runs split the daily quota across them, and the weekly review shifts it toward what works."),
    ...(tracks.length ? tracks.map((t) =>
      h("div", { class: "card" },
        h("h3", {}, t.name, " ", h("span", { class: "pill s-" + (t.status === "active" ? "submitted" : "skipped") }, t.status)),
        h("p", { class: "note", style: "margin:4px 0 8px" }, t.hypothesis),
        h("div", { class: "fit" }, n(t.sent) + " submitted · " + n(t.waiting) + " need a person · " + n(t.interviews) + " interviews"),
      )) : [h("div", { class: "empty" }, "Tracks appear after the first run.")]),
  );
}

async function renderActivity(view) {
  if (!state.activity) {
    view.replaceChildren(h("div", { class: "empty" }, "Loading…"));
    state.activity = await api("/api/activity");
  }
  const a = state.activity;
  view.replaceChildren(
    a.emails.length ? h("div", { class: "sec" }, h("h4", {}, "Employer emails"),
      h("div", { class: "feed" }, ...a.emails.map((e) => h("div", {}, h("time", {}, when(e.at) + " · " + (e.company || e.from_domain)), outcomePill(e.kind), " ", e.subject)))) : null,
    h("div", { class: "sec" }, h("h4", {}, "What the runs did"),
      h("div", { class: "feed" }, ...(a.journal.length ? a.journal.map((j) => h("div", {}, h("time", {}, when(j.at) + " · " + j.kind), j.text)) : [h("div", { class: "empty" }, "No runs yet.")]))),
  );
}

function renderView() {
  const view = document.getElementById("view");
  if (state.tab === "applications") return renderApplications(view);
  if (state.tab === "screened") return renderScreened(view).catch(showError);
  if (state.tab === "strategy") return renderStrategy(view);
  return renderActivity(view).catch(showError);
}

async function openJob(id) {
  const dlg = document.getElementById("detail");
  const j = await api("/api/jobs/" + encodeURIComponent(id));
  const file = (f) => "/files/" + encodeURIComponent(j.id) + "/" + encodeURIComponent(f);
  const pdfs = j.files.filter((f) => /\.pdf$/i.test(f));
  const resume = pdfs.find((f) => /resume/i.test(f)) || pdfs[0];
  const factors = j.screen.factors ? Object.entries(j.screen.factors) : [];
  const list = (title, items) => (items && items.length ? h("div", { class: "sec" }, h("h4", {}, title), h("ul", {}, ...items.map((x) => h("li", {}, x)))) : null);
  const kw = j.packet && j.packet.keywords;
  dlg.replaceChildren(
    h("div", { class: "dh" },
      h("div", {}, h("h2", { id: "dtitle" }, j.title), h("div", { class: "c sub" }, [j.company, j.location].filter(Boolean).join(" · "))),
      h("button", { class: "close", onclick: () => dlg.close() }, "Close")),
    h("div", { class: "db" },
      h("div", {}, pill(j.status), " ", outcomePill(j.outcome), j.fit != null ? h("span", { class: "fit" }, "  fit " + j.fit + " of 100") : null),
      h("p", { class: "note" }, STATUS_HELP[j.status] || "", j.submittedAt ? " Submitted " + when(j.submittedAt) + "." : j.preparedAt ? " Prepared " + when(j.preparedAt) + "." : ""),
      j.status === "needs_human" && j.reason ? h("p", { class: "note" }, "What it stopped on: " + j.reason) : null,
      h("div", { class: "docs" },
        ...pdfs.map((f) => h("a", { class: "btn", href: file(f), target: "_blank", rel: "noopener" }, /cover/i.test(f) ? "Cover letter (PDF)" : /resume/i.test(f) ? "Resume (PDF)" : f)),
        j.url ? h("a", { class: "btn", href: j.url, target: "_blank", rel: "noopener noreferrer" }, "Job posting") : null,
        j.applyUrl && j.applyUrl !== j.url ? h("a", { class: "btn", href: j.applyUrl, target: "_blank", rel: "noopener noreferrer" }, "Apply page") : null),
      resume ? h("iframe", { class: "pdf", src: file(resume), title: "Resume" }) : null,
      factors.length ? h("div", { class: "sec" }, h("h4", {}, "Why it fits"),
        ...factors.map(([k, v]) => h("div", { class: "factor" }, h("span", {}, FACTOR[k] || k), h("div", { class: "bar" }, h("i", { style: "width:" + Math.round(v * 100) + "%" })), h("span", { class: "fit" }, Math.round(v * 100))))) : null,
      list("Strengths", j.screen.strengths),
      list("Gaps", j.screen.gaps),
      list("Requirements to check", j.screen.gates),
      list("Warnings", j.screen.warnings),
      kw && kw.gaps && kw.gaps.length ? h("div", { class: "sec" }, h("h4", {}, "Posting terms not in the CV pool"), h("p", { class: "note" }, kw.gaps.join(", "))) : null,
      j.salary ? h("div", { class: "sec" }, h("h4", {}, "Pay"), h("p", {}, [j.salary.min, j.salary.max].filter((x) => x != null).map((x) => "$" + Number(x).toLocaleString()).join(" – "))) : null,
      j.description ? h("details", { class: "sec" }, h("summary", {}, "Read the posting"), h("pre", { class: "desc" }, j.description)) : null,
    ),
  );
  if (!dlg.open) dlg.showModal();
}

function showError(e) {
  document.getElementById("view").replaceChildren(h("div", { class: "empty" }, "Couldn't load: " + e.message));
}

async function refresh() {
  try {
    const [summary, apps] = await Promise.all([api("/api/summary"), api("/api/applications")]);
    state.summary = summary;
    state.apps = apps;
    state.screened = null;
    state.activity = null;
    renderSummary(summary);
    if (!document.getElementById("detail").open && document.activeElement?.tagName !== "INPUT") renderView();
  } catch (e) {
    showError(e);
  }
}

renderTabs();
refresh();
setInterval(refresh, 120000);
`;
