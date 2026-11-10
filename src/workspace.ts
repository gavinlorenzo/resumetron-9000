import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import type { z } from "zod";
import { Config } from "./config.ts";
import { AnswerBank, Goal, Pool, Standard } from "./schema.ts";

export interface Workspace {
  root: string;
  config: string;
  pool: string;
  goal: string;
  answers: string;
  coverTemplate: string;
  standards: string;
  applications: string;
  ledger: string;
}

export function workspaceAt(home?: string): Workspace {
  const root = resolve(home ?? process.env.RESUMETRON_HOME ?? join(homedir(), ".resumetron"));
  return {
    root,
    config: join(root, "config.yaml"),
    pool: join(root, "pool.yaml"),
    goal: join(root, "goal.yaml"),
    answers: join(root, "answers.yaml"),
    coverTemplate: join(root, "cover-template.md"),
    standards: join(root, "standards"),
    applications: join(root, "applications"),
    ledger: join(root, "ledger.db"),
  };
}

export function readYaml<S extends z.ZodType>(path: string, schema: S, hint: string): z.output<S> {
  if (!existsSync(path)) throw new Error(`${path} does not exist. ${hint}`);
  try {
    return schema.parse(YAML.parse(readFileSync(path, "utf8")) ?? {});
  } catch (e) {
    throw new Error(`${path} is invalid: ${e instanceof Error ? e.message : e}`);
  }
}

export function writeYaml(path: string, value: unknown): void {
  writeFileSync(path, YAML.stringify(value, { lineWidth: 0 }));
}

export const loadConfig = (ws: Workspace) => readYaml(ws.config, Config, "Run `resumetron init` first.");
export const loadPool = (ws: Workspace) => readYaml(ws.pool, Pool, "Run `resumetron import <files>` first.");
export const loadGoal = (ws: Workspace) => readYaml(ws.goal, Goal, "Run `resumetron interview` first.");
export const loadAnswers = (ws: Workspace): AnswerBank =>
  existsSync(ws.answers) ? readYaml(ws.answers, AnswerBank, "") : { answers: [] };

export function loadStandards(ws: Workspace): Standard[] {
  if (!existsSync(ws.standards)) return [];
  return readdirSync(ws.standards)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => readYaml(join(ws.standards, f), Standard, ""));
}

const DEFAULT_CONFIG = `# The Resumetron 9000 configuration.
# Pick ONE provider block. API keys are read from environment variables, never stored here.

provider:
  type: anthropic
  model: claude-opus-5-5
  apiKeyEnv: ANTHROPIC_API_KEY
  effort: medium

# provider:          # OpenAI, OpenRouter, Groq, Ollama, LM Studio: anything OpenAI-compatible
#   type: openai
#   model: gpt-5
#   baseUrl: https://api.openai.com/v1
#   apiKeyEnv: OPENAI_API_KEY

# provider:          # Any local agent CLI, using your subscription. Prompt arrives on stdin.
#   type: command    # Job postings are untrusted text, so turn the agent's tools OFF.
#   command: claude -p --tools "" --strict-mcp-config --no-session-persistence

mode: tailored       # tailored | efficiency
submit: review       # review = you approve each one | auto = submits unattended, within quota

quota:
  maxPerDay: 10
  maxPerRun: 5
  maxPerCompanyPer30Days: 2
  minDelaySeconds: 90
  maxTokensPerRun: 400000

matching:
  maxAgeDays: 30
  minKeywordScore: 0.15
  minFit: 70
  maxScreenPerRun: 20

resume:
  maxPages: 1

coverLetter:
  tailored: generated   # off | template | generated
  efficiency: template

efficiency:
  minStandardScore: 0.3
  answerQuestionsWithLlm: false

# sources:
#   usajobs:
#     apiKeyEnv: USAJOBS_API_KEY
#     contactEmailEnv: USAJOBS_EMAIL
#   adzuna:
#     appIdEnv: ADZUNA_APP_ID
#     appKeyEnv: ADZUNA_APP_KEY
#     country: us

browser:
  headless: true
`;

const DEFAULT_ANSWERS = `# Standing answers to application questions. The AI never answers questions
# about work authorization, salary, demographics, criminal history, or legal
# attestations: it uses what you write here, or stops and asks you.
# "match" is a case-insensitive regex tested against the question's label.

answers: []

# Examples:
# answers:
#   - match: authorized to work
#     answer: "Yes"
#   - match: sponsorship
#     answer: "No"
#   - match: how did you hear
#     answer: Company website
#   - match: gender|race|ethnic|veteran|disability
#     answer: Decline to self-identify
`;

const DEFAULT_COVER = `Dear {{company}} Hiring Team,

I am writing to apply for the {{title}} position at {{company}}. My enclosed resume outlines my background, and I would welcome the chance to discuss how I can contribute to your team.

Thank you for your time and consideration.
`;

export function initWorkspace(ws: Workspace): string[] {
  mkdirSync(ws.standards, { recursive: true });
  mkdirSync(ws.applications, { recursive: true });
  const created: string[] = [];
  for (const [path, body] of [
    [ws.config, DEFAULT_CONFIG],
    [ws.answers, DEFAULT_ANSWERS],
    [ws.coverTemplate, DEFAULT_COVER],
  ] as const) {
    if (!existsSync(path)) {
      writeFileSync(path, body);
      created.push(path);
    }
  }
  return created;
}
