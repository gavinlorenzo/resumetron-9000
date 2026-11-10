import type { Page } from "playwright";
import { comboOptions } from "./extract.ts";
import type { Resolution } from "./resolve.ts";

const el = (page: Page, id: string) => page.locator(`[data-rt-id="${id}"]`);

/** Writes resolved values into the form. Returns labels that could not be filled. */
export async function fillForm(page: Page, resolutions: Resolution[]): Promise<string[]> {
  const failed: string[] = [];
  for (const r of resolutions) {
    if (r.status !== "fill" || r.value === undefined) continue;
    const f = r.field;
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
        default:
          await loc.fill(String(r.value));
      }
    } catch {
      failed.push(f.label);
    }
  }
  return failed;
}

export type SubmitOutcome = "submitted" | "unconfirmed" | "failed" | "blocked";

const CONFIRM = /thank(s| you)[^.]{0,40}(appl|submit|interest)|application (has been |was )?(received|submitted|sent)|we('ve| have) received your application|successfully (submitted|applied)/i;
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
  await Promise.race([page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {}), page.waitForTimeout(20_000)]);
  await page.waitForTimeout(1500);

  const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
  if (CONFIRM.test(body)) return { outcome: "submitted", detail: "confirmation page recognized" };
  for (const frame of await page.locator(CHALLENGE).all()) {
    if (await frame.isVisible().catch(() => false)) return { outcome: "blocked", detail: "the site asked for a human verification challenge" };
  }
  const invalid = await page.locator('[aria-invalid="true"], .error:visible, .field-error:visible, [class*="error"]:visible').count();
  if (invalid > 0 && page.url() === before) return { outcome: "failed", detail: `${invalid} field(s) flagged by the site after submit` };
  return { outcome: "unconfirmed", detail: `no confirmation text recognized (now at ${page.url()})` };
}
