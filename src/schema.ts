import { z } from "zod";

// ---- CV pool: everything you've ever done. Also the shape of a composed resume. ----

export const Bullet = z.object({
  id: z.string(),
  text: z.string(),
  tags: z.array(z.string()).default([]),
});

export const Role = z.object({
  id: z.string(),
  title: z.string(),
  dates: z.string(),
  meta: z.string().optional(), // e.g. "20hr/wk"
  bullets: z.array(Bullet).default([]),
});

export const ExperienceEntry = z.object({
  id: z.string(),
  org: z.string(),
  location: z.string().optional(),
  roles: z.array(Role),
});

export const EducationEntry = z.object({
  id: z.string(),
  degree: z.string(),
  date: z.string(),
  school: z.string(),
  location: z.string().optional(),
  left: z.array(z.string()).default([]),
  right: z.array(z.string()).default([]),
});

export const InlineItem = z.object({
  id: z.string(),
  text: z.string(),
  note: z.string().optional(),
});

export const InlineEntry = z.object({
  id: z.string(),
  label: z.string().optional(),
  items: z.array(InlineItem),
});

const sectionBase = { key: z.string(), heading: z.string() };

export const Section = z.discriminatedUnion("type", [
  z.object({
    ...sectionBase,
    type: z.literal("experience"),
    layout: z.enum(["org-first", "role-first"]).default("org-first"),
    entries: z.array(ExperienceEntry),
  }),
  z.object({ ...sectionBase, type: z.literal("education"), entries: z.array(EducationEntry) }),
  z.object({ ...sectionBase, type: z.literal("inline"), entries: z.array(InlineEntry) }),
]);

export const Contact = z.object({
  name: z.string(),
  phone: z.string().optional(),
  email: z.string().optional(),
  links: z.array(z.string()).default([]),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  country: z.string().optional(),
});

export const Pool = z.object({
  contact: Contact,
  sections: z.array(Section),
  /** Loose true statements for cover letters and form questions. Never rendered on the resume. */
  facts: z.array(z.string()).default([]),
});

export type Bullet = z.infer<typeof Bullet>;
export type Role = z.infer<typeof Role>;
export type Section = z.infer<typeof Section>;
export type Contact = z.infer<typeof Contact>;
export type Pool = z.infer<typeof Pool>;
export type ResumeDoc = Pick<Pool, "contact" | "sections">;

// ---- Search goal, produced by the interview. ----

export const CompanyBoard = z.object({
  ats: z.enum(["greenhouse", "lever", "ashby"]),
  token: z.string(),
  name: z.string().optional(),
  /** Your own reasons for wanting to work there. Cover letters may draw on these. */
  notes: z.string().optional(),
});

/**
 * What the seeker has said about their eligibility. Used only by code (src/gates.ts) to reject
 * postings that clearly require something they lack. null means "not said": nothing is rejected on it.
 */
export const Eligibility = z
  .object({
    needsSponsorship: z.boolean().nullable().default(null),
    usCitizen: z.boolean().nullable().default(null),
    /** none: can't get one. eligible: could obtain one. active: holds one now. */
    clearance: z.enum(["none", "eligible", "active"]).nullable().default(null),
    yearsExperience: z.number().nullable().default(null),
    degree: z.enum(["none", "associate", "bachelor", "master", "doctorate"]).nullable().default(null),
    /** Languages other than English they work in. Empty means "not said". */
    languages: z.array(z.string()).default([]),
  })
  .prefault({});
export type Eligibility = z.infer<typeof Eligibility>;

/** One opening bet about where interviews will come from. See src/strategy.ts. */
export const TrackSeed = z.object({
  name: z.string(),
  /** The bet, and what in their background makes them competitive there. */
  hypothesis: z.string(),
  roles: z.array(z.string()).default([]),
  /** 1-4 words each, as typed into a job board. */
  queries: z.array(z.string()).default([]),
  employers: z.array(z.string()).default([]),
});
export type TrackSeed = z.infer<typeof TrackSeed>;

export const Goal = z.object({
  summary: z.string().default(""),
  /**
   * focused: the roles named here. broad: anything the CV makes them roughly half-qualified for;
   * the planner widens the search into adjacent roles and screening accepts stretch roles.
   */
  breadth: z.enum(["focused", "broad"]).default("focused"),
  targetRoles: z.array(z.string()).default([]),
  titleInclude: z.array(z.string()).default([]),
  titleExclude: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
  remoteOk: z.boolean().default(true),
  remoteOnly: z.boolean().default(false),
  minSalary: z.number().nullable().optional(),
  dealbreakers: z.array(z.string()).default([]),
  companies: z.array(CompanyBoard).default([]),
  searches: z.array(z.object({ query: z.string(), location: z.string().optional() })).default([]),
  blockedCompanies: z.array(z.string()).default([]),
  notes: z.string().default(""),
  /**
   * The opening strategy, when it was worked out with the job seeker (the /resumetron skill
   * writes these). The first run starts these tracks as written instead of drafting its own.
   * Read only once: after that the ledger owns the tracks and the weekly review revises them.
   */
  tracks: z.array(TrackSeed).default([]),
  eligibility: Eligibility,
});
export type Goal = z.infer<typeof Goal>;

// ---- Standing answers to form questions. Only you write these facts. ----

export const AnswerEntry = z.object({
  match: z.string(), // case-insensitive regex tested against the field label
  answer: z.string(),
  note: z.string().optional(),
});
export const AnswerBank = z.object({ answers: z.array(AnswerEntry).default([]) });
export type AnswerBank = z.infer<typeof AnswerBank>;

// ---- What the model returns when tailoring. IDs only, plus reworded bullet text. ----

export const TailorPlan = z.object({
  sections: z.array(
    z.object({
      key: z.string(),
      entries: z.array(
        z.object({
          id: z.string(),
          roles: z
            .array(
              z.object({
                id: z.string(),
                bullets: z.array(z.object({ id: z.string(), text: z.string() })),
              }),
            )
            .optional(),
          items: z.array(z.string()).optional(),
        }),
      ),
    }),
  ),
  /**
   * IDs (bullet, role, entry, inline item, or section key) worth showing if space remains,
   * best first. The renderer adds them in order until the page is full.
   */
  reserve: z.array(z.string()).default([]),
  rationale: z.string().default(""),
});
export type TailorPlan = z.infer<typeof TailorPlan>;

// ---- Reusable resumes for efficiency mode. ----

export const Standard = z.object({
  name: z.string(),
  targets: z.array(z.string()),
  keywords: z.array(z.string()).default([]),
  plan: TailorPlan,
});
export type Standard = z.infer<typeof Standard>;

// ---- A job posting, normalized across sources. ----

export interface Job {
  id: string;
  source: string;
  company: string;
  title: string;
  location: string;
  remote: boolean;
  url: string;
  applyUrl: string;
  description: string;
  postedAt?: string;
  salaryMin?: number;
  salaryMax?: number;
  /** False when the posting can only be finished on a portal needing a human login. */
  autoApplicable: boolean;
  /** For remote roles: the countries or regions the employer hires from, when it says. */
  remoteRegions?: string[];
  /** What the posting scrubber and legitimacy checks noticed. Shown to you; screening sees them too. */
  flags?: string[];
}
