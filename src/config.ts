import { z } from "zod";

export const ProviderConfig = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("anthropic"),
    model: z.string().default("claude-opus-5-5"),
    apiKeyEnv: z.string().default("ANTHROPIC_API_KEY"),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  }),
  z.object({
    // OpenAI itself, OpenRouter, Groq, Together, Ollama, LM Studio, llama.cpp, vLLM...
    type: z.literal("openai"),
    model: z.string(),
    baseUrl: z.string().default("https://api.openai.com/v1"),
    apiKeyEnv: z.string().optional(),
  }),
  z.object({
    // Any local agent CLI. The prompt arrives on stdin; the reply is read from stdout.
    type: z.literal("command"),
    command: z.string(),
    timeoutSeconds: z.number().default(600),
  }),
]);
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const Config = z.object({
  provider: ProviderConfig,
  /** tailored: a custom resume per job. efficiency: reuse standard resumes, near-zero tokens. */
  mode: z.enum(["tailored", "efficiency"]).default("tailored"),
  /** review: prepare everything and wait for approval. auto: submit unattended. */
  submit: z.enum(["review", "auto"]).default("review"),
  quota: z
    .object({
      maxPerDay: z.number().default(10),
      maxPerRun: z.number().default(5),
      maxPerCompanyPer30Days: z.number().default(2),
      minDelaySeconds: z.number().default(90),
      maxTokensPerRun: z.number().default(400_000),
    })
    .prefault({}),
  matching: z
    .object({
      maxAgeDays: z.number().default(30),
      minKeywordScore: z.number().default(0.15),
      minFit: z.number().default(70),
      maxScreenPerRun: z.number().default(20),
    })
    .prefault({}),
  resume: z
    .object({
      maxPages: z.number().default(1),
      /** Fill leftover space with the tailor's ranked reserve items instead of leaving white space. */
      fill: z.boolean().default(true),
    })
    .prefault({}),
  coverLetter: z
    .object({
      tailored: z.enum(["off", "template", "generated"]).default("generated"),
      efficiency: z.enum(["off", "template", "generated"]).default("template"),
    })
    .prefault({}),
  efficiency: z
    .object({
      minStandardScore: z.number().default(0.3),
      answerQuestionsWithLlm: z.boolean().default(false),
    })
    .prefault({}),
  sources: z
    .object({
      usajobs: z.object({ apiKeyEnv: z.string(), contactEmailEnv: z.string() }).optional(),
      adzuna: z
        .object({ appIdEnv: z.string(), appKeyEnv: z.string(), country: z.string().default("us") })
        .optional(),
    })
    .prefault({}),
  browser: z
    .object({
      headless: z.boolean().default(true),
      channel: z.string().optional(),
      navigationTimeoutMs: z.number().default(45_000),
    })
    .prefault({}),
});
export type Config = z.infer<typeof Config>;
