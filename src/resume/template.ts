import type { Contact, ResumeDoc, Section } from "../schema.ts";
import { escapeHtml as h } from "../util.ts";

// The standard format: centered name, pipe-separated contact line, ruled uppercase
// headings, "Org | Location" over "Role | Dates" entries, round bullets, serif type.

const CSS = (fontPt: number) => `
  @page { size: Letter; margin: 0.5in; }
  * { box-sizing: border-box; }
  html { font-size: ${fontPt}pt; }
  body { margin: 0; font-family: "Times New Roman", "Liberation Serif", "Nimbus Roman", Times, serif;
         color: #000; line-height: 1.1; -webkit-print-color-adjust: exact; }
  header { text-align: center; margin-bottom: 0.9em; }
  header h1 { font-size: 1.32rem; margin: 0 0 0.1em; font-weight: bold; }
  header div { line-height: 1.25; }
  a { color: #1155cc; text-decoration: underline; }
  section { margin-top: 0.75em; }
  h2 { font-size: 1rem; font-weight: bold; text-transform: uppercase; margin: 0 0 0.15em;
       border-bottom: 1px solid #000; padding-bottom: 1px; }
  .entry { margin-bottom: 0.55em; }
  .entry:last-child { margin-bottom: 0; }
  .line { margin: 0; }
  ul { margin: 0.05em 0 0.15em; padding-left: 3.1em; }
  li { list-style: none; position: relative; }
  li::before { content: "\\25CF"; position: absolute; left: -1.25em; font-size: 0.82em; top: 0.08em; }
  .edu { display: grid; grid-template-columns: 1fr 1fr; column-gap: 1em; }
  .inline p { margin: 0; }
  .letter p { margin: 0 0 0.9em; }
`;

function contactLine(c: Contact): string {
  const parts: string[] = [];
  if (c.phone) parts.push(h(c.phone));
  if (c.email) parts.push(`<a href="mailto:${h(c.email)}">${h(c.email)}</a>`);
  for (const l of c.links) parts.push(`<a href="${h(l.startsWith("http") ? l : `https://${l}`)}">${h(l)}</a>`);
  const where = c.address ?? [c.city, c.state].filter(Boolean).join(", ");
  return `<header><h1>${h(c.name)}</h1><div>${parts.join(" | ")}</div>${where ? `<div>${h(where)}</div>` : ""}</header>`;
}

const joinBar = (...xs: (string | undefined)[]) => xs.filter(Boolean).map((x) => h(x!)).join(" | ");

function section(s: Section): string {
  let body = "";
  if (s.type === "experience") {
    for (const e of s.entries) {
      let html = "";
      if (s.layout === "org-first") {
        html += `<p class="line"><b>${h(e.org)}</b>${e.location ? ` | ${h(e.location)}` : ""}</p>`;
      }
      for (const r of e.roles) {
        html += `<p class="line"><b>${h(r.title)}</b> | ${joinBar(r.dates, r.meta)}</p>`;
        if (s.layout === "role-first") html += `<p class="line">${joinBar(e.org, e.location)}</p>`;
        if (r.bullets.length) html += `<ul>${r.bullets.map((b) => `<li>${h(b.text)}</li>`).join("")}</ul>`;
      }
      body += `<div class="entry">${html}</div>`;
    }
  } else if (s.type === "education") {
    for (const e of s.entries) {
      const rows = Math.max(e.left.length, e.right.length);
      let grid = "";
      for (let i = 0; i < rows; i++) grid += `<div>${h(e.left[i] ?? "")}</div><div>${h(e.right[i] ?? "")}</div>`;
      body += `<div class="entry"><p class="line"><b>${h(e.degree)}</b>, ${h(e.date)}</p>
        <p class="line">${h([e.school, e.location].filter(Boolean).join(", "))}</p>
        ${rows ? `<div class="edu">${grid}</div>` : ""}</div>`;
    }
  } else {
    const ps = s.entries.map((e) => {
      const items = e.items.map((i) =>
        e.label ? `${h(i.text)}${i.note ? ` (${h(i.note)})` : ""}` : `<b>${h(i.text)}</b>${i.note ? ` (${h(i.note)})` : ""}`,
      );
      return `<p>${e.label ? `<b>${h(e.label)}:</b> ` : ""}${items.join(", ")}</p>`;
    });
    body = `<div class="inline">${ps.join("")}</div>`;
  }
  return `<section><h2>${h(s.heading)}</h2>${body}</section>`;
}

export function resumeHtml(doc: ResumeDoc, fontPt: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${h(doc.contact.name)} Resume</title>
    <style>${CSS(fontPt)}</style></head><body>${contactLine(doc.contact)}${doc.sections.map(section).join("")}</body></html>`;
}

export function coverHtml(contact: Contact, paragraphs: string[], fontPt = 11.5): string {
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${h(contact.name)} Cover Letter</title>
    <style>${CSS(fontPt)} .letter { margin-top: 1.5em; line-height: 1.35; }</style></head>
    <body>${contactLine(contact)}<div class="letter"><p>${h(date)}</p>
    ${paragraphs.map((p) => `<p>${h(p)}</p>`).join("")}
    <p>Sincerely,<br>${h(contact.name)}</p></div></body></html>`;
}
