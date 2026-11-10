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

export const Goal = z.object({
  summary: z.string().default(""),
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
}
