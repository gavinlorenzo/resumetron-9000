import type { Page } from "playwright";

// Workday applications, adapted from autoapply-mcp's Workday flow (MIT, (c) 2026 autoapply-mcp
// contributors). A Workday posting shows an advert, then an Apply modal, then (on most tenants)
// an account gate; the application is a wizard of 4-8 pages that must each be saved before the
// next exists, ending at a Review page whose footer button is Submit. Every employer is its own
// tenant with its own accounts. Selectors are Workday's `data-automation-id`s, which come from
// the platform rather than the employer, so they hold across tenants.

export const isWorkdayUrl = (raw: string) => {
  try {
    return /(^|\.)myworkday(jobs|site)\.com$/i.test(new URL(raw).hostname);
  } catch {
    return false;
  }
};

/** The employer's tenant: `acme` for acme.wd5.myworkdayjobs.com. */
export function workdayTenant(raw: string): string | undefined {
  try {
    const label = new URL(raw).hostname.toLowerCase().split(".")[0];
    return /^(www|wd\d+|myworkdayjobs|myworkdaysite)$/.test(label) ? undefined : label;
  } catch {
    return undefined;
  }
}

export const SEL = {
  apply: '[data-automation-id="adventureButton"]',
  applyManually: '[data-automation-id="applyManually"]',
  signInWithEmail: '[data-automation-id="SignInWithEmailButton"]',
  googleSignIn: '[data-automation-id="GoogleSignInButton"]',
  email: '[data-automation-id="email"]',
  password: '[data-automation-id="password"]',
  verifyPassword: '[data-automation-id="verifyPassword"]',
  createAccountSubmit: '[data-automation-id="createAccountSubmitButton"]',
  createAccountCheckbox: '[data-automation-id="createAccountCheckbox"]',
  signInSubmit: '[data-automation-id="signInSubmitButton"]',
  signInLink: '[data-automation-id="signInLink"]',
  createAccountLink: '[data-automation-id="createAccountLink"]',
  errorBanner: '[data-automation-id="errorMessage"]',
  step: '[data-automation-id="progressBarActiveStep"]',
  next: ['[data-automation-id="pageFooterNextButton"]', '[data-automation-id="bottom-navigation-next-button"]'],
  resumeInput: 'input[type="file"]',
} as const;

const visible = (page: Page, sel: string) => page.locator(sel).first().isVisible().catch(() => false);
const bodyText = async (page: Page) => ((await page.locator("body").innerText({ timeout: 1000 }).catch(() => "")) ?? "").replace(/\s+/g, " ");

/**
 * Clicks a Workday control. Workday lays a transparent `click_filter` div over each real button
 * and that overlay takes the click, so a plain click can time out; the overlay is clicked instead.
 */
export async function clickIfPresent(page: Page, selector: string, timeoutMs = 8000): Promise<boolean> {
  const loc = page.locator(selector).first();
  if (!(await loc.waitFor({ state: "visible", timeout: timeoutMs }).then(() => true, () => false))) return false;
  try {
    await loc.click({ timeout: Math.min(timeoutMs, 5000) });
  } catch {
    const how = await page
      .evaluate((sel) => {
        const target = document.querySelector(sel);
        if (!target) return "missing";
        const norm = (v: string | null) => (v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
        const label = norm(target.textContent) || norm(target.getAttribute("aria-label"));
        let node = target.parentElement;
        for (let d = 0; d < 4 && node; d++) {
          const overlays = [...node.querySelectorAll('[data-automation-id="click_filter"]')] as HTMLElement[];
          const match = overlays.length === 1 ? overlays[0] : overlays.find((o) => norm(o.getAttribute("aria-label")) === label);
          if (match) {
            match.click();
            return "overlay";
          }
          node = node.parentElement;
        }
        (target as HTMLElement).click();
        return "direct";
      }, selector)
      .catch(() => "missing");
    if (how === "missing") return false;
  }
  await page.waitForTimeout(2500);
  return true;
}

const DEAD = /page you are looking for (does ?n[o']?t|doesn't) exist|no longer (available|accepting)|job (posting )?(has been )?(closed|removed)|requisition .*(closed|no longer)/i;
const VERIFY = /verify your (account|email)|email has been sent to you|verification (email|link)/i;
const TRANSIENT = /something went wrong/i;

/** Waits for the advert to render: Workday paints its header long before the posting. */
async function awaitAdvert(page: Page, timeoutMs: number): Promise<"advert" | "dead" | "form" | "blank"> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const text = await bodyText(page);
    if (DEAD.test(text) && (await visible(page, SEL.errorBanner))) return "dead";
    if (await atForm(page)) return "form";
    if (text.length > 200 && ((await visible(page, SEL.apply)) || (await visible(page, '[data-automation-id="jobPostingDescription"]')))) return "advert";
    if ((await visible(page, SEL.email)) || (await visible(page, SEL.signInWithEmail))) return "advert";
    await page.waitForTimeout(1000);
  }
  return "blank";
}

export async function stepName(page: Page): Promise<string> {
  return ((await page.locator(SEL.step).first().innerText({ timeout: 1000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
}

/** The account gate is step 1 of the wizard on many tenants; only a non-account step is the form. */
export async function atForm(page: Page): Promise<boolean> {
  if (new URL(page.url()).pathname.split("/").some((s) => s.toLowerCase() === "login")) return false;
  if (await atGate(page)) return false;
  const step = await stepName(page);
  if (step && /create account|sign ?in|log ?in/i.test(step)) return false;
  for (const sel of [SEL.step, '[data-automation-id^="formField-"]', ...SEL.next]) if (await visible(page, sel)) return true;
  return false;
}

export async function atGate(page: Page): Promise<boolean> {
  for (const sel of [SEL.password, SEL.signInWithEmail, SEL.googleSignIn, SEL.email]) if (await visible(page, sel)) return true;
  return false;
}

export interface WorkdayAccount {
  email: string;
  password: string;
}

export interface EntryOptions {
  account?: WorkdayAccount;
  /** Registering an account on this employer's tenant is allowed. */
  allowCreate: boolean;
  /** Waits for Workday's verification email and returns its link, or null. */
  awaitLink?: (since: Date) => Promise<string | null>;
  /** Called once an account was created, so it can be recorded. */
  onCreated?: (tenant: string) => void;
}

export interface EntryResult {
  reached: "form" | "gate" | "closed" | "blocked";
  detail: string;
}

/**
 * Walks from the advert to the application. Signs in before ever registering, so an existing
 * account is never duplicated. Never uses "Autofill with Resume": Workday's parser invents field
 * values from the PDF, and every value here has to come from you.
 */
export async function enterWorkday(page: Page, o: EntryOptions): Promise<EntryResult> {
  const advert = await awaitAdvert(page, 45_000);
  if (advert === "dead") return { reached: "closed", detail: "Workday says this posting no longer exists" };
  if (advert === "form") return { reached: "form", detail: "the application opened directly" };
  if (await visible(page, SEL.apply)) await clickIfPresent(page, SEL.apply, 15_000);
  await clickIfPresent(page, SEL.applyManually, 8000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // Some tenants take applications without an account (a guest flow); give it time to render.
  for (let i = 0; i < 8; i++) {
    if (await atForm(page)) return { reached: "form", detail: "this employer takes applications without an account" };
    if (await atGate(page)) break;
    await page.waitForTimeout(1500);
  }
  await clickIfPresent(page, SEL.signInWithEmail, 12_000);
  if (!(await visible(page, SEL.password))) {
    if (await atForm(page)) return { reached: "form", detail: "already signed in" };
    return advert === "advert"
      ? { reached: "blocked", detail: "no application form or sign-in appeared; the posting may be closed or the site changed" }
      : { reached: "blocked", detail: "the posting never rendered; the site is slow or refusing this browser, so whether it's open is unknown" };
  }
  const tenant = workdayTenant(page.url()) ?? "this employer";
  if (!o.account) {
    return { reached: "gate", detail: `${tenant}'s Workday needs an account; set the Workday password variable (see \`workday:\` in config.yaml)` };
  }

  const signedIn = await signIn(page, o.account);
  if (signedIn.ok) return { reached: "form", detail: `signed in to your ${tenant} Workday account` };

  if (VERIFY.test(signedIn.detail)) {
    if (!o.awaitLink) return { reached: "gate", detail: `your ${tenant} account isn't verified yet: open the email Workday sent to ${o.account.email}, then try again` };
    const since = new Date();
    if (!(await requestVerification(page))) return { reached: "gate", detail: `your ${tenant} account isn't verified yet, and no "resend" control was found` };
    return verifyThenSignIn(page, o.account, o.awaitLink, since, tenant);
  }
  if (!o.allowCreate) {
    return { reached: "gate", detail: `no ${tenant} Workday account signs in with your details (${signedIn.detail}); \`resumetron apply <id> --create-account\` registers one` };
  }
  return createAccount(page, o, tenant);
}

async function signIn(page: Page, a: WorkdayAccount): Promise<{ ok: boolean; detail: string }> {
  if (!(await visible(page, SEL.password)) && (await visible(page, SEL.signInWithEmail))) await clickIfPresent(page, SEL.signInWithEmail, 10_000);
  // Some tenants open on the registration form; switch to sign-in.
  if (await visible(page, SEL.verifyPassword)) {
    if (!(await clickIfPresent(page, SEL.signInLink, 5000))) return { ok: false, detail: "couldn't switch to the sign-in form" };
  }
  const email = page.locator(SEL.email).first();
  await email.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  if (!(await email.isVisible().catch(() => false))) return { ok: false, detail: "the sign-in form didn't open" };
  await email.fill(a.email);
  await page.locator(SEL.password).first().fill(a.password);
  await clickIfPresent(page, SEL.signInSubmit, 8000);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  for (let i = 0; i < 6; i++) {
    if (!(await atGate(page))) return { ok: true, detail: "signed in" };
    await page.waitForTimeout(1000);
  }
  const error = (await page.locator(SEL.errorBanner).first().innerText({ timeout: 1000 }).catch(() => "")).trim();
  return { ok: false, detail: redact(error ? `sign-in refused: ${error.slice(0, 200)}` : "sign-in didn't complete", a.password) };
}

/** The tenant's stated password minimum ("A minimum of 14 characters"), or 0. */
export function statedMinimum(text: string): number {
  return Math.max(0, ...[...text.matchAll(/\b(?:minimum(?: of)?|at least)\s+(\d{1,2})\s+characters?\b/gi)].map((m) => Number(m[1])));
}

/** Repeats the password up to a tenant's minimum: the same on every run, so it can sign in again. */
export const lengthened = (pw: string, min: number) => (pw.length >= min ? pw : pw.repeat(Math.ceil(min / pw.length)));

async function createAccount(page: Page, o: EntryOptions, tenant: string): Promise<EntryResult> {
  const a = o.account!;
  if (!(await visible(page, SEL.verifyPassword)) && !(await clickIfPresent(page, SEL.createAccountLink, 5000))) {
    return { reached: "blocked", detail: "couldn't reach the create-account form" };
  }
  const min = statedMinimum(await bodyText(page));
  const account = { ...a, password: lengthened(a.password, min) };
  await page.locator(SEL.email).first().fill(account.email);
  await page.locator(SEL.password).first().fill(account.password);
  await page.locator(SEL.verifyPassword).first().fill(account.password);
  // Workday's own "I agree to the terms of this account" box. Ticking it is part of the
  // registration you explicitly asked for with --create-account / createAccounts.
  if (await visible(page, SEL.createAccountCheckbox)) await page.locator(SEL.createAccountCheckbox).first().check({ force: true }).catch(() => {});
  const since = new Date();
  await clickIfPresent(page, SEL.createAccountSubmit, 8000);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

  for (let i = 0; i < 12; i++) {
    if (await visible(page, SEL.verifyPassword)) {
      if (await visible(page, SEL.errorBanner)) {
        const error = (await page.locator(SEL.errorBanner).first().innerText({ timeout: 1000 }).catch(() => "")).trim();
        return { reached: "blocked", detail: redact(`registration refused: ${error.slice(0, 200)}`, account.password) };
      }
    } else if (await atForm(page)) {
      o.onCreated?.(tenant);
      return { reached: "form", detail: `created a ${tenant} Workday account for ${account.email}` };
    } else if (await atGate(page)) {
      o.onCreated?.(tenant);
      if (VERIFY.test(await bodyText(page))) {
        if (!o.awaitLink) return { reached: "gate", detail: `created a ${tenant} account; open the verification email sent to ${account.email}, then try again` };
        return verifyThenSignIn(page, account, o.awaitLink, since, tenant);
      }
      const s = await signIn(page, account);
      if (s.ok) return { reached: "form", detail: `created a ${tenant} Workday account and signed in` };
      if (VERIFY.test(s.detail) && o.awaitLink) return verifyThenSignIn(page, account, o.awaitLink, since, tenant);
      return { reached: "gate", detail: `created a ${tenant} account, but signing in didn't complete (${s.detail})` };
    }
    await page.waitForTimeout(1500);
  }
  return { reached: "blocked", detail: `sent the ${tenant} registration, but nothing recognizable came back; try again to sign in` };
}

async function requestVerification(page: Page): Promise<boolean> {
  for (const sel of ['[data-automation-id="click_filter"][aria-label*="resend" i]', '[data-automation-id*="resend" i]', "text=/resend (account )?verification/i"]) {
    if (await clickIfPresent(page, sel, 3000)) return true;
  }
  return false;
}

/** Opens the emailed link in a second tab (only https Workday links), then signs in on the first. */
async function verifyThenSignIn(page: Page, a: WorkdayAccount, awaitLink: (since: Date) => Promise<string | null>, since: Date, tenant: string): Promise<EntryResult> {
  const link = await awaitLink(since).catch(() => null);
  if (!link) return { reached: "gate", detail: `no Workday verification email arrived for your ${tenant} account; open it yourself, then try again` };
  if (!isVerificationLink(link)) return { reached: "gate", detail: "the verification email's link isn't a Workday link, so it wasn't opened" };
  const tab = await page.context().newPage();
  try {
    await tab.goto(link, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await tab.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  } catch {
    return { reached: "gate", detail: "the emailed verification link wouldn't open" };
  } finally {
    await tab.close().catch(() => {});
  }
  if (!(await atGate(page))) {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(3000);
    if (await atForm(page)) return { reached: "form", detail: `verified your ${tenant} account` };
  }
  const s = await signIn(page, a);
  return s.ok ? { reached: "form", detail: `verified your ${tenant} account and signed in` } : { reached: "gate", detail: `verified the account, but signing in didn't complete (${s.detail})` };
}

export function isVerificationLink(link: string): boolean {
  try {
    const u = new URL(link);
    return u.protocol === "https:" && !u.username && !u.password && /(^|\.)myworkday(jobs|site)?\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Finds the verification link in an email body. */
export function verificationLinkIn(text: string): string | null {
  for (const m of text.matchAll(/https:\/\/[^\s"'<>)\]]+/g)) {
    const url = m[0].replace(/[.,;]+$/, "");
    if (isVerificationLink(url) && /verif|activat|confirm|token/i.test(url)) return url;
  }
  return null;
}

export const redact = (text: string, secret: string) => (secret.length >= 4 ? text.split(secret).join("[redacted]") : text);

/** Workday's transient "Something went wrong. Please refresh" page recovers on reload. */
export async function recover(page: Page): Promise<void> {
  for (let i = 0; i < 2 && TRANSIENT.test(await bodyText(page)); i++) {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
}

/**
 * Saves the step and moves to the next one. Refuses a button labeled Submit: the last page's
 * footer button sends the application, which only the guarded submit path may do.
 */
export async function advance(page: Page): Promise<boolean> {
  for (const sel of SEL.next) {
    const button = page.locator(sel).first();
    if (!(await button.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false))) continue;
    const label = ((await button.innerText({ timeout: 1000 }).catch(() => "")) ?? "").trim();
    if (/\bsubmit\b/i.test(label)) return false;
    if (!(await clickIfPresent(page, sel, 8000))) continue;
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    return true;
  }
  return false;
}

/** Clicks the Review page's Submit button. */
export async function pressSubmit(page: Page): Promise<boolean> {
  for (const sel of SEL.next) {
    const button = page.locator(sel).first();
    if (!(await button.isVisible().catch(() => false))) continue;
    const label = ((await button.innerText({ timeout: 1000 }).catch(() => "")) ?? "").trim();
    if (!/\bsubmit\b/i.test(label)) continue;
    return clickIfPresent(page, sel, 8000);
  }
  return false;
}

/** "The field X is required and must have a value": questions a previous answer revealed. */
export function requiredErrors(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.replace(/\s+/g, " ").matchAll(/The field (.{3,400}?) is required and must have a value/g)) {
    const label = m[1].replace(/\*/g, "").replace(/\s*:\s*$/, "").trim();
    if (label) found.add(label);
  }
  return [...found];
}

/** Attaches the resume once. Workday keeps files on your profile, so it's never uploaded twice. */
export async function attachResume(page: Page, path: string): Promise<boolean> {
  const name = path.split(/[\\/]/).pop()!;
  if ((await bodyText(page)).includes(name)) return true;
  const input = page.locator(SEL.resumeInput).first();
  if (!(await input.count())) return false;
  for (let i = 0; i < 3; i++) {
    await input.setInputFiles(path).catch(() => {});
    for (let w = 0; w < 6; w++) {
      await page.waitForTimeout(1500);
      if ((await bodyText(page)).includes(name)) return true;
    }
  }
  return false;
}

/**
 * Values you answered that the Review page doesn't say back. A signed-in Workday draft can carry
 * values from earlier sessions, so a wizard that reports success isn't proof the form says
 * what you said. Only distinctive values are checked: a bare "Yes" is everywhere.
 */
export function reviewOmissions(reviewText: string, answered: { label: string; value: string }[]): { label: string; value: string }[] {
  const hay = reviewText.replace(/\s+/g, " ").toLowerCase();
  return answered.filter(({ value }) => {
    const v = value.replace(/\s+/g, " ").trim().toLowerCase();
    if (v.length < 4 || /^(yes|no|true|false|n\/a|none)$/.test(v) || /[\\/]/.test(v) && /\.(pdf|docx?)$/.test(v)) return false;
    if (hay.includes(v)) return false;
    const words = v.split(/[^a-z0-9@.+]+/).filter((w) => w.length >= 3);
    return !(words.length && words.every((w) => hay.includes(w)));
  });
}
