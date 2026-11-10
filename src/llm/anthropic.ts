import Anthropic from "@anthropic-ai/sdk";
import type { ProviderConfig } from "../config.ts";
import type { Llm } from "./index.ts";

// Models that accept adaptive thinking and the effort setting.
const MODERN = /^claude-(fable|mythos|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5)/;
// Models with server-side refusal fallback.
const FALLBACK = /^claude-(fable-5|mythos-5|opus-5|sonnet-5-5)/;

export function createAnthropic(cfg: Extract<ProviderConfig, { type: "anthropic" }>): Llm {
  const apiKey = process.env[cfg.apiKeyEnv];
  // With no key the SDK still resolves `ant auth login` profiles.
  const client = new Anthropic(apiKey ? { apiKey } : {});
  const modern = MODERN.test(cfg.model);
  const fallback = FALLBACK.test(cfg.model);

  return {
    async complete(req) {
      const system: any[] = [{ type: "text", text: req.system }];
      if (req.stable) {
        // The pool and goal repeat on every job, so they sit behind a cache breakpoint.
        system.push({ type: "text", text: req.stable, cache_control: { type: "ephemeral" } });
      }
      const params: any = {
        model: cfg.model,
        max_tokens: req.maxTokens ?? 16_000,
        system,
        messages: req.messages,
        ...(modern ? { thinking: { type: "adaptive" }, output_config: { effort: cfg.effort } } : {}),
        ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      };
      const message: any = await client.beta.messages.stream(params).finalMessage();
      if (message.stop_reason === "refusal") throw new Error("the model declined this request");
      if (message.stop_reason === "max_tokens") throw new Error("the model reply hit max_tokens");
      const text = message.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      const u = message.usage;
      return {
        text,
        usage: {
          input: u.input_tokens + (u.cache_creation_input_tokens ?? 0),
          output: u.output_tokens,
          cached: u.cache_read_input_tokens ?? 0,
        },
      };
    },
  };
}
