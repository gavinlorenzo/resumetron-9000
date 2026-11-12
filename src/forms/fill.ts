import type { Page } from "playwright";
import { comboOptions } from "./extract.ts";
import { matchOption, type Resolution } from "./resolve.ts";

const el = (page: Page, id: string) => page.locator(`[data-rt-id="${id}"]`);

/** Writes resolved values into the form. Returns labels that could not be filled. */
export async function fillForm(page: Page, resolutions: Resolution[]): Promise<string[]> {
  const failed: string[] = [];
  for (const r of resolutions) {
    if (r.status !== "fill" || r.value === undefined) continue;
    const f = r.field;
    // Already showing this answer (a site default or saved draft): re-picking can only break it.
    if (f.value && ["prompt", "combobox", "select"].includes(f.kind) && matchOption(String(r.value), [f.value])) continue;
    try {
      const loc = el(page, f.rtId);
      switch (f.kind) {
        case "file":
          await loc.setInputFiles(String(r.value));
          break;
        case "select":
          await loc.selectOption({ label: String(r.value) });
          break;
        case "radio":
          await el(page, f.optionIds![String(r.value)]).check({ force: true });
          break;
        case "checkbox-group":
          for (const v of r.value as string[]) await el(page, f.optionIds![v]).check({ force: true });
          break;
        case "checkbox":
          if (r.value === "true") await loc.check({ force: true });
          break;
        case "combobox": {
          const value = String(r.value);
          await loc.click();
          // Typing filters the menu; a few characters keep option text intact for matching.
          await loc.pressSequentially(value.slice(0, 24), { delay: 15 }).catch(() => {});
          await page.waitForTimeout(400);
          if (!(await comboOptions(page, f.rtId).pick(value))) await page.keyboard.press("Enter");
          break;
        }
        case "prompt":
          if (!(await pickPrompt(page, f.rtId, String(r.value)))) throw new Error("no matching option");
          break;
        default:
          await loc.fill(String(r.value));
      }
    } catch {
      failed.push(f.label);
    }
  }
  return failed;
}

/**
 * Workday's search-and-pick prompts: type the answer, press Enter, and choose the offered option
 * that matches it (one level of nesting, e.g. "Job Board" > "LinkedIn"). False if nothing matches.
 */
async function pickPrompt(page: Page, rtId: string, value: string): Promise<boolean> {
  const loc = el(page, rtId);
  const wrapper = loc.locator('xpath=ancestor::*[starts-with(@data-automation-id, "formField-")][1]');
  const chosen = async () => ((await wrapper.locator('[data-automation-id="selectedItemList"]').innerText({ timeout: 1000 }).catch(() => "")) ?? "").trim().length > 0;
  await loc.click();
  await loc.fill(value.slice(0, 40));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  for (let level = 0; level < 2; level++) {
    const options = page.locator('[data-automation-id="promptOption"], [data-automation-id="promptLeafNode"]').filter({ visible: true });
    const texts = (await options.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
    const pick = matchOption(value, texts);
    if (!pick) break;
    await options.nth(texts.indexOf(pick)).click();
    await page.waitForTimeout(1200);
    if (await chosen()) {
      await page.keyboard.press("Escape").catch(() => {});
      return true;
    }
  }
  await page.keyboard.press("Escape").catch(() => {});
  return chosen();
}

export type SubmitOutcome = "submitted" | "unconfirmed" | "failed" | "blocked";

const CONFIRM = /thank(s| you)[^.]{0,40}(appl|submit|interest)|application submitted|you('ve| have) (successfully )?applied|application (has been |was )?(received|submitted|sent)|we('ve| have) received your application|successfully (submitted|applied)/i;
const CONFIRM_URL = /\/(thank-?you|thanks|confirmation|confirmed|success|submitted|application-submitted)\b/i;
const CHALLENGE = 'iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"], iframe[title*="challenge" i]';

/** Clicks submit once and reports what the page did. Never retries, never works around a CAPTCHA. */
export async function submitForm(page: Page): Promise<{ outcome: SubmitOutcome; detail: string }> {
  const button = page
    .locator('form button[type=submit], form input[type=submit], button:has-text("Submit"), button:has-text("Apply")')
    .filter({ visible: true })
    .first();
  if (!(await button.count())) return { outcome: "failed", detail: "no submit button found" };
  const before = page.url();
  await button.click();
  return readOutcome(page, before);
}

/** After a submit click: what the page says happened. Reads up to three times as it settles. */
export async function readOutcome(page: Page, before: string): Promise<{ outcome: SubmitOutcome; detail: string }> {
  await Promise.race([page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {}), page.waitForTimeout(20_000)]);
  await page.waitForTimeout(1500);

  // Some confirmations render late or after a redirect: read the page up to three times.
  let body = "";
  for (let i = 0; i < 3; i++) {
    body = (await page.locator("body").innerText({ timeout: 1000 }).catch(() => "")) ?? "";
    if (CONFIRM.test(body)) return { outcome: "submitted", detail: "confirmation page recognized" };
    if (page.url() !== before && CONFIRM_URL.test(new URL(page.url()).pathname)) {
      return { outcome: "submitted", detail: `the site moved to a confirmation page (${page.url()})` };
    }
    await page.waitForTimeout(2500);
  }
  for (const frame of await page.locator(CHALLENGE).all()) {
    if (await frame.isVisible().catch(() => false)) return { outcome: "blocked", detail: "the site asked for a human verification challenge" };
  }
  const invalid = await page.locator('[aria-invalid="true"], .error:visible, .field-error:visible, [class*="error"]:visible').count();
  if (invalid > 0 && page.url() === before) return { outcome: "failed", detail: `${invalid} field(s) flagged by the site after submit` };
  return { outcome: "unconfirmed", detail: `no confirmation text recognized (now at ${page.url()})` };
}
