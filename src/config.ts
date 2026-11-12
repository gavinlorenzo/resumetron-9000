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
      /** Bar when goal.breadth is "broad": roles you're roughly half-qualified for. */
      minFitBroad: z.number().default(50),
      maxScreenPerRun: z.number().default(20),
      /** How screening's five factor ratings combine into the fit score. Normalized, so they needn't sum to 1. */
      weights: z
        .object({
          requirements: z.number().default(0.35),
          experience: z.number().default(0.2),
          education: z.number().default(0.1),
          domain: z.number().default(0.15),
          goals: z.number().default(0.2),
        })
        .prefault({}),
      /** Check that a posting is still open before screening it and before applying. */
      checkLiveness: z.boolean().default(true),
    })
    .prefault({}),
  campaign: z
    .object({
      /** HTTP requests to job sources per run, across boards, searches, and board lookups. */
      maxRequestsPerRun: z.number().default(40),
      /** Pages per search per run: page 1 for new postings, then deeper from where the last run stopped. */
      maxPagesPerQuery: z.number().default(3),
      boardSweepHours: z.number().default(20),
      /** A search is retired after this many runs in a row that surface nothing new. */
      exhaustAfterEmptyRuns: z.number().default(3),
      /** Planner (one model call) every N runs; 0 turns it off. */
      plannerEveryRuns: z.number().default(1),
      plannerInEfficiencyMode: z.boolean().default(false),
      maxNewQueriesPerRun: z.number().default(6),
      discoverBoards: z.boolean().default(true),
      maxProbesPerRun: z.number().default(6),
    })
    .prefault({}),
  retention: z
    .object({
      /** Rejected and skipped jobs are kept as small dedupe records for this long, then deleted. */
      tombstoneDays: z.number().default(180),
      /** Most jobs waiting to be screened; the lowest-scored beyond this are dropped. */
      backlogMax: z.number().default(400),
      journalMax: z.number().default(300),
      inactiveQueriesMax: z.number().default(300),
      probeDays: z.number().default(90),
      screenshotsDays: z.number().default(14),
      /** Packets of skipped, failed, and preview applications. Sent applications keep their PDFs. */
      packetDays: z.number().default(30),
      logDays: z.number().default(14),
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
      // Free, keyless keyword search. Remote roles only, so used when goal.remoteOk is true.
      himalayas: z.boolean().default(true),
      remotive: z.boolean().default(true),
      usajobs: z.object({ apiKeyEnv: z.string(), contactEmailEnv: z.string() }).optional(),
      adzuna: z
        .object({ appIdEnv: z.string(), appKeyEnv: z.string(), country: z.string().default("us") })
        .optional(),
    })
    .prefault({}),
  /** IMAP/SMTP: reads employer replies to track outcomes, and applies by email where a posting asks for it. */
  email: z
    .object({
      provider: z.enum(["gmail", "outlook", "custom"]).default("custom"),
      address: z.string(),
      user: z.string().optional(), // defaults to address
      passwordEnv: z.string().default("RESUMETRON_EMAIL_PASSWORD"),
      imap: z.object({ host: z.string(), port: z.number().default(993), secure: z.boolean().default(true) }).optional(),
      smtp: z.object({ host: z.string(), port: z.number().default(465), secure: z.boolean().default(true) }).optional(),
      fromName: z.string().optional(),
      /** Apply by email when a posting asks for it (still subject to `submit` and quotas). */
      send: z.boolean().default(true),
      /** Messages read per run, newest last. */
      maxPerSync: z.number().default(200),
    })
    .optional(),
  /** Follow-ups on quiet applications: drafted for you to send (email applications can send in-thread). */
  followup: z
    .object({
      afterDays: z.number().default(7),
      everyDays: z.number().default(7),
      max: z.number().default(2),
    })
    .prefault({}),
  strategy: z
    .object({
      reviewEveryDays: z.number().default(7),
      /** New tracks the strategist proposes start exploring on a small slice; true makes them full tracks at once. */
      autoApprove: z.boolean().default(false),
      explorationShare: z.number().default(0.1),
      minShare: z.number().default(0.1),
      cementedMinShare: z.number().default(0.25),
      maxTracks: z.number().default(5),
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
