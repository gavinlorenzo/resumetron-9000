import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import YAML from "yaml";
import type { Llm, LlmRequest } from "../src/llm/index.ts";
import { identityPlan } from "../src/resume/compose.ts";
import { Pool } from "../src/schema.ts";

export const examplePool = () =>
  Pool.parse(YAML.parse(readFileSync(new URL("../examples/pool.example.yaml", import.meta.url), "utf8")));

/** A scripted model. Records every request so tests can inspect what it was shown. */
export function mockLlm(pool: Pool): Llm & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async complete(req) {
      calls.push(req);
      const reply = (() => {
        switch (req.purpose) {
          case "screen":
            return { factors: { requirements: 0.9, experience: 0.8, education: 0.9, domain: 0.9, goals: 0.9 }, dealbreaker: false, reason: "policy research role matching the internship", gaps: ["GIS mapping"], strengths: ["briefing memos"], track: 1 };
          case "strategy":
            return {
              memo: "Two bets to start.",
              tracks: [
                { name: "Local policy analysis", hypothesis: "Municipal internship makes them credible for city and county policy roles.", roles: ["Policy Analyst"], queries: [], employers: [] },
                { name: "Community programs", hypothesis: "Listening sessions and debate coaching fit program coordination.", roles: ["Program Coordinator"], queries: [], employers: [] },
              ],
            };
          case "tailor": {
            const plan = identityPlan(pool);
            plan.sections.reverse();
            return plan;
          }
          case "cover": {
            if (req.messages[0].content.includes("<letter>")) {
              return { edits: [{ old: "Your posting also asks for help to support", new: "Your posting also asks for someone to support", why: "tighter" }] };
            }
            const company = req.messages[0].content.match(/Company: (.+)/)![1];
            return {
              hooks: [
                { quote: "write briefing memos", angle: "memo drafted as an intern" },
                { quote: "support community engagement programs", angle: "listening sessions" },
              ],
              paragraphs: [
                `Dear ${company} Hiring Team,`,
                `${company} asks its analysts to write briefing memos that local leaders act on. As a Policy Intern I researched zoning policy in 8 peer cities and drafted the briefing memo council staff used.`,
                "Your posting also asks for help to support community engagement programs; I organized 3 public listening sessions attended by over 200 residents.",
                "I also won a Pulitzer Prize in 2019.",
              ],
            };
          }
          case "form": {
            const qs = JSON.parse(req.messages[0].content.split("<questions>\n")[1].split("\n</questions>")[0]);
            return { answers: qs.map((q: any) => ({ id: q.id, answer: /interested/i.test(q.question) ? "I want to turn research into policy that serves residents." : null })) };
          }
          default:
            throw new Error(`unexpected purpose ${req.purpose}`);
        }
      })();
      return { text: JSON.stringify(reply), usage: { input: 1000, output: 200, cached: 0 } };
    },
  };
}

export interface FakeBoard {
  url: string;
  submissions: string[];
  close(): Promise<void>;
}

/** Serves the fixture application form and records what gets posted. */
export async function fakeBoard(): Promise<FakeBoard> {
  const form = readFileSync(new URL("./fixtures/apply.html", import.meta.url), "utf8");
  const submissions: string[] = [];
  const server = createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.setEncoding("latin1");
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        submissions.push(body);
        res.writeHead(200, { "Content-Type": "text/html" }).end("<h1>Thank you for applying!</h1><p>Your application has been received.</p>");
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" }).end(form);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, submissions, close: () => new Promise((r) => server.close(() => r())) };
}
