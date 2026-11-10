import { type GuardIssue, checkBullet } from "../guard.ts";
import type { Pool, ResumeDoc, Section, TailorPlan } from "../schema.ts";

/**
 * Builds a resume from a tailoring plan. Every dated, titled, or named field is copied
 * from the pool; the plan contributes only selection, order, and checked bullet wording.
 */
export function compose(pool: Pool, plan: TailorPlan): { doc: ResumeDoc; issues: GuardIssue[] } {
  const issues: GuardIssue[] = [];
  const byKey = new Map(pool.sections.map((s) => [s.key, s]));
  const sections: Section[] = [];

  for (const ps of plan.sections) {
    const src = byKey.get(ps.key);
    if (!src) {
      issues.push({ where: ps.key, problem: "plan names a section the pool lacks; skipped", text: "" });
      continue;
    }
    if (sections.some((s) => s.key === src.key)) continue;

    if (src.type === "experience") {
      const entries = [];
      for (const pe of ps.entries) {
        const entry = src.entries.find((e) => e.id === pe.id);
        if (!entry) continue;
        const roles = [];
        for (const pr of pe.roles ?? entry.roles.map((r) => ({ id: r.id, bullets: r.bullets }))) {
          const role = entry.roles.find((r) => r.id === pr.id);
          if (!role) continue;
          const bullets = [];
          for (const pb of pr.bullets) {
            const original = role.bullets.find((b) => b.id === pb.id);
            if (!original) continue;
            const context = `${entry.org} ${entry.location ?? ""} ${role.title}`;
            const problems = pb.text === original.text ? [] : checkBullet(pb.text, original.text, context);
            if (problems.length) {
              issues.push({ where: original.id, problem: `${problems.join("; ")}; kept original wording`, text: pb.text });
              bullets.push(original);
            } else {
              bullets.push({ ...original, text: pb.text });
            }
          }
          roles.push({ ...role, bullets });
        }
        if (roles.length) entries.push({ ...entry, roles });
      }
      if (entries.length) sections.push({ ...src, entries });
    } else if (src.type === "education") {
      const entries = ps.entries.map((pe) => src.entries.find((e) => e.id === pe.id)).filter((e) => e !== undefined);
      if (entries.length) sections.push({ ...src, entries });
    } else {
      const entries = [];
      for (const pe of ps.entries) {
        const entry = src.entries.find((e) => e.id === pe.id);
        if (!entry) continue;
        const items = pe.items
          ? pe.items.map((id) => entry.items.find((i) => i.id === id)).filter((i) => i !== undefined)
          : entry.items;
        if (items.length) entries.push({ ...entry, items });
      }
      if (entries.length) sections.push({ ...src, entries });
    }
  }

  // Education is never dropped, only moved.
  for (const s of pool.sections) {
    if (s.type === "education" && !sections.some((x) => x.key === s.key)) sections.push(s);
  }
  return { doc: { contact: pool.contact, sections }, issues };
}

/** The plan that reproduces the pool exactly, in pool order. */
export function identityPlan(pool: Pool): TailorPlan {
  return {
    rationale: "full pool",
    sections: pool.sections.map((s) => ({
      key: s.key,
      entries: s.entries.map((e: any) =>
        s.type === "experience"
          ? { id: e.id, roles: e.roles.map((r: any) => ({ id: r.id, bullets: r.bullets.map((b: any) => ({ id: b.id, text: b.text })) })) }
          : s.type === "inline"
            ? { id: e.id, items: e.items.map((i: any) => i.id) }
            : { id: e.id },
      ),
    })),
  };
}

/**
 * Removes the least important remaining unit so the page can fit: the plan lists things
 * most-relevant first, so trimming works from the end. Returns false when nothing is left to cut.
 */
export function trimOnce(doc: ResumeDoc): boolean {
  for (let si = doc.sections.length - 1; si >= 0; si--) {
    const s = doc.sections[si];
    if (s.type === "education") continue;
    if (s.type === "experience") {
      const entry = s.entries[s.entries.length - 1];
      const role = entry.roles[entry.roles.length - 1];
      if (role.bullets.length > 1) role.bullets.pop();
      else if (entry.roles.length > 1) entry.roles.pop();
      else if (s.entries.length > 1) s.entries.pop();
      else doc.sections.splice(si, 1);
      return true;
    }
    const entry = s.entries[s.entries.length - 1];
    if (entry.items.length > 1) entry.items.pop();
    else if (s.entries.length > 1) s.entries.pop();
    else doc.sections.splice(si, 1);
    return true;
  }
  return false;
}

export function docToText(doc: ResumeDoc): string {
  const lines: string[] = [doc.contact.name];
  for (const s of doc.sections) {
    lines.push("", s.heading.toUpperCase());
    for (const e of s.entries as any[]) {
      if (s.type === "experience") {
        lines.push(`${e.org}${e.location ? ` | ${e.location}` : ""}`);
        for (const r of e.roles) {
          lines.push(`${r.title} | ${r.dates}${r.meta ? ` | ${r.meta}` : ""}`);
          for (const b of r.bullets) lines.push(`- ${b.text}`);
        }
      } else if (s.type === "education") {
        lines.push(`${e.degree}, ${e.date}`, `${e.school}${e.location ? `, ${e.location}` : ""}`, ...e.left, ...e.right);
      } else {
        lines.push(`${e.label ? `${e.label}: ` : ""}${e.items.map((i: any) => (i.note ? `${i.text} (${i.note})` : i.text)).join(", ")}`);
      }
    }
  }
  return lines.join("\n");
}

/** Pool as compact JSON with IDs, for prompts. */
export const poolForPrompt = (pool: Pool) => JSON.stringify({ sections: pool.sections, facts: pool.facts });
