import { spawn } from "node:child_process";
import type { z } from "zod";
import type { ProviderConfig } from "../config.ts";
import { sleep } from "../util.ts";
import { createAnthropic } from "./anthropic.ts";

export interface LlmRequest {
  purpose: string;
  system: string;
  /** Large content repeated across calls (pool, goal). Providers that can cache it, will. */
  stable?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
}

export interface LlmUsage {
  input: number;
  output: number;
  cached: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
}

export interface Llm {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class BudgetExceededError extends Error {}

export function metered(
  inner: Llm,
  limit: number,
  record: (purpose: string, usage: LlmUsage) => void,
): Llm & { spent(): number } {
  let spent = 0;
  return {
    spent: () => spent,
    async complete(req) {
      if (spent >= limit) throw new BudgetExceededError(`token budget of ${limit} reached`);
      const res = await inner.complete(req);
      spent += res.usage.input + res.usage.output;
      record(req.purpose, res.usage);
      return res;
    },
  };
}

function createOpenAi(cfg: Extract<ProviderConfig, { type: "openai" }>): Llm {
  const base = cfg.baseUrl.replace(/\/$/, "");
  const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
  if (cfg.apiKeyEnv && !key) throw new Error(`environment variable ${cfg.apiKeyEnv} is not set`);
  const tokenParam = base.includes("api.openai.com") ? "max_completion_tokens" : "max_tokens";
  return {
    async complete(req) {
      const body = {
        model: cfg.model,
        [tokenParam]: req.maxTokens ?? 16_000,
        messages: [
          { role: "system", content: [req.system, req.stable].filter(Boolean).join("\n\n") },
          ...req.messages,
        ],
      };
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(600_000),
        });
        if ((res.status === 429 || res.status >= 500) && attempt < 3) {
          await sleep(2000 * 2 ** attempt);
          continue;
        }
        if (!res.ok) throw new Error(`provider returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data: any = await res.json();
        return {
          text: data.choices?.[0]?.message?.content ?? "",
          usage: {
            input: data.usage?.prompt_tokens ?? 0,
            output: data.usage?.completion_tokens ?? 0,
            cached: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          },
        };
      }
    },
  };
}

function createCommand(cfg: Extract<ProviderConfig, { type: "command" }>): Llm {
  return {
    complete(req) {
      const prompt = [
        req.system,
        req.stable,
        ...req.messages.map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}:\n${m.content}`),
      ]
        .filter(Boolean)
        .join("\n\n");
      return new Promise((resolve, reject) => {
        // The command string comes from the user's own config. The prompt, which
        // contains untrusted job text, only ever travels over stdin.
        const child = spawn(cfg.command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`provider command timed out after ${cfg.timeoutSeconds}s`));
        }, cfg.timeoutSeconds * 1000);
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) return reject(new Error(`provider command exited ${code}: ${err.slice(0, 300)}`));
          // CLIs rarely report usage; estimate so quotas still work.
          resolve({
            text: out,
            usage: { input: Math.ceil(prompt.length / 4), output: Math.ceil(out.length / 4), cached: 0 },
          });
        });
        child.stdin.on("error", () => {}); // a CLI that exits early surfaces through 'close'
        child.stdin.end(prompt);
      });
    },
  };
}

export function createLlm(cfg: ProviderConfig): Llm {
  switch (cfg.type) {
    case "anthropic":
      return createAnthropic(cfg);
    case "openai":
      return createOpenAi(cfg);
    case "command":
      return createCommand(cfg);
  }
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[{[]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (start < 0 || end < start) throw new Error("no JSON found in model reply");
  return JSON.parse(body.slice(start, end + 1));
}

/** Calls the model for JSON matching `schema`, giving it one chance to repair a bad reply. */
export async function completeJson<S extends z.ZodType>(
  llm: Llm,
  req: LlmRequest,
  schema: S,
  shape: string,
): Promise<z.output<S>> {
  const system = `${req.system}\n\nReply with a single JSON object and nothing else, in this shape:\n${shape}`;
  const first = await llm.complete({ ...req, system });
  try {
    return schema.parse(extractJson(first.text));
  } catch (e) {
    const repaired = await llm.complete({
      ...req,
      system,
      messages: [
        ...req.messages,
        { role: "assistant", content: first.text },
        { role: "user", content: `That reply could not be used (${String(e).slice(0, 500)}). Send the corrected JSON object only.` },
      ],
    });
    return schema.parse(extractJson(repaired.text));
  }
}
