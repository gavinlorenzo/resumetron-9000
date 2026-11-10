import { type Browser, type Page, chromium } from "playwright";
import { coverHtml, resumeHtml } from "./resume/template.ts";
import { trimOnce } from "./resume/compose.ts";
import type { Contact, ResumeDoc } from "./schema.ts";

// Letter paper minus 0.5in margins, at 96 CSS px per inch.
const CONTENT_WIDTH_PX = 720;
const CONTENT_HEIGHT_PX = 960;
const FONT_STEPS = [11, 10.5, 10];

export interface BrowserOptions {
  headless: boolean;
  channel?: string;
}

/** One shared browser for rendering PDFs and filling application forms. */
export class BrowserHost {
  private browser?: Browser;
  private opts: BrowserOptions;

  constructor(opts: BrowserOptions) {
    this.opts = opts;
  }

  async newPage(headless = this.opts.headless): Promise<Page> {
    if (!headless) {
      // Handoff windows get their own visible browser.
      const b = await this.launch(false);
      const page = await b.newPage();
      page.on("close", () => void b.close());
      return page;
    }
    this.browser ??= await this.launch(true);
    return this.browser.newPage();
  }

  private async launch(headless: boolean): Promise<Browser> {
    try {
      return await chromium.launch({ headless, channel: this.opts.channel });
    } catch (e) {
      if (!this.opts.channel) {
        // No bundled browser installed: fall back to the system's Chrome.
        try {
          return await chromium.launch({ headless, channel: "chrome" });
        } catch {}
      }
      throw new Error(`could not start a browser (run \`npx playwright install chromium\`): ${e}`);
    }
  }

  /** Renders the resume, shrinking type then trimming the least relevant lines until it fits. */
  async renderResume(input: ResumeDoc, outPath: string, maxPages = 1): Promise<{ doc: ResumeDoc; trimmed: number; fontPt: number }> {
    const doc: ResumeDoc = structuredClone(input);
    const page = await this.newPage(true);
    try {
      await page.setViewportSize({ width: CONTENT_WIDTH_PX, height: CONTENT_HEIGHT_PX });
      await page.emulateMedia({ media: "print" });
      const limit = CONTENT_HEIGHT_PX * maxPages - 4;
      const height = async (pt: number) => {
        await page.setContent(resumeHtml(doc, pt));
        return page.evaluate(() => document.body.getBoundingClientRect().height);
      };
      let fontPt = FONT_STEPS[0];
      let trimmed = 0;
      for (;;) {
        const fit = await (async () => {
          for (const pt of FONT_STEPS) if ((await height(pt)) <= limit) return pt;
          return undefined;
        })();
        if (fit !== undefined) {
          fontPt = fit;
          break;
        }
        if (!trimOnce(doc)) {
          fontPt = FONT_STEPS[FONT_STEPS.length - 1];
          break;
        }
        trimmed++;
      }
      await page.setContent(resumeHtml(doc, fontPt));
      await page.pdf({ path: outPath, format: "Letter", printBackground: true, preferCSSPageSize: true });
      return { doc, trimmed, fontPt };
    } finally {
      await page.close();
    }
  }

  async renderCover(contact: Contact, paragraphs: string[], outPath: string): Promise<void> {
    const page = await this.newPage(true);
    try {
      await page.setContent(coverHtml(contact, paragraphs));
      await page.pdf({ path: outPath, format: "Letter", printBackground: true, preferCSSPageSize: true });
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
  }
}
