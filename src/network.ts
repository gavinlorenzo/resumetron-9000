import { readFileSync } from "node:fs";
import { type Ledger, companyKey } from "./ledger.ts";

// Your own network, from LinkedIn's data export (Settings > Data privacy > Get a copy of your
// data > Connections). A referral or a warm note beats a cold application by a wide margin, so
// each job shows who you already know there. Nothing here touches the network: it's a local join.

export interface Contact {
  name: string;
  company: string;
  position: string;
  url: string;
  connected_on: string;
}

/** Splits one CSV line, honoring quotes. */
function csvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Reads LinkedIn's Connections.csv. The export starts with a few lines of notes before the header. */
export function parseConnections(csv: string): Contact[] {
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/);
  const headerAt = lines.findIndex((l) => /first name/i.test(l) && /company/i.test(l));
  if (headerAt < 0) throw new Error("no header row with First Name and Company: is this LinkedIn's Connections.csv?");
  const header = csvLine(lines[headerAt]).map((h) => h.toLowerCase());
  const col = (name: string) => header.findIndex((h) => h === name);
  const [first, last, url, company, position, on] = ["first name", "last name", "url", "company", "position", "connected on"].map(col);
  const out: Contact[] = [];
  for (const line of lines.slice(headerAt + 1)) {
    if (!line.trim()) continue;
    const f = csvLine(line);
    const name = [f[first], f[last]].filter(Boolean).join(" ").trim();
    if (!name || !f[company]) continue;
    out.push({ name, company: f[company], position: f[position] ?? "", url: f[url] ?? "", connected_on: f[on] ?? "" });
  }
  return out;
}

function ensure(ledger: Ledger): void {
  ledger.db.exec(`CREATE TABLE IF NOT EXISTS contacts (
    url TEXT, name TEXT NOT NULL, company TEXT NOT NULL, company_key TEXT NOT NULL, position TEXT, connected_on TEXT,
    PRIMARY KEY (name, company_key)
  ); CREATE INDEX IF NOT EXISTS contacts_company ON contacts(company_key);`);
}

/** Replaces the stored connections with a fresh export. Returns how many were stored. */
export function importConnections(ledger: Ledger, path: string): number {
  const contacts = parseConnections(readFileSync(path, "utf8"));
  ensure(ledger);
  ledger.batch(() => {
    ledger.db.exec("DELETE FROM contacts");
    const ins = ledger.db.prepare("INSERT OR REPLACE INTO contacts (url, name, company, company_key, position, connected_on) VALUES (?, ?, ?, ?, ?, ?)");
    for (const c of contacts) ins.run(c.url, c.name, c.company, companyKey(c.company), c.position, c.connected_on);
  });
  return contacts.length;
}

/** People you're connected to at a company. */
export function knownAt(ledger: Ledger, company: string): Contact[] {
  ensure(ledger);
  return ledger.db.prepare("SELECT name, company, position, url, connected_on FROM contacts WHERE company_key = ? ORDER BY name").all(companyKey(company)) as any[];
}

/** Companies where you know someone, with counts: worth adding as boards to watch. */
export function networkCompanies(ledger: Ledger, limit = 30): { company: string; n: number }[] {
  ensure(ledger);
  return ledger.db
    .prepare("SELECT MIN(company) AS company, COUNT(*) AS n FROM contacts GROUP BY company_key ORDER BY n DESC LIMIT ?")
    .all(limit) as any[];
}
