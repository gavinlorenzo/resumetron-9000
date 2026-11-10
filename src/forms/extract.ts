import type { Page } from "playwright";

export type FieldKind =
  | "text" | "email" | "tel" | "url" | "number" | "date" | "textarea"
  | "select" | "radio" | "checkbox" | "checkbox-group" | "file" | "combobox";

export interface FormField {
  /** Stable handle written onto the element as data-rt-id. Radio/checkbox groups key options separately. */
  rtId: string;
  kind: FieldKind;
  label: string;
  required: boolean;
  options: string[];
  /** For radio and checkbox groups: option label -> element handle. */
  optionIds?: Record<string, string>;
}

/** Reads the application form on the page into a list of labeled fields. */
export async function extractFields(page: Page): Promise<FormField[]> {
  const fields: FormField[] = await page.evaluate(() => {
    let counter = 0;
    const tag = (el: Element) => {
      const existing = el.getAttribute("data-rt-id");
      if (existing) return existing;
      const id = `rt${++counter}`;
      el.setAttribute("data-rt-id", id);
      return id;
    };
    const textOf = (node: Element | null): string => {
      if (!node) return "";
      const clone = node.cloneNode(true) as Element;
      clone.querySelectorAll("input,select,textarea,option,ul,[role=listbox],script,style").forEach((n) => n.remove());
      return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return (
        r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0" &&
        r.right > 0 && r.bottom > 0 && r.left < innerWidth + 50
      );
    };
    const container = (el: Element) =>
      el.closest(".application-question,.field,.form-group,.form-field,[class*='question'],[class*='Field'],[class*='field'],fieldset,li");
    const questionLabel = (el: Element): string => {
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const t = labelledBy.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(" ").trim();
        if (t) return t;
      }
      const aria = el.getAttribute("aria-label");
      if (aria) return aria;
      const input = el as HTMLInputElement;
      if (input.labels?.length) {
        const t = textOf(input.labels[0]);
        if (t) return t;
      }
      const c = container(el);
      if (c) {
        const l = c.querySelector("legend,label,.application-label,[class*='label'],[class*='Label']");
        const t = textOf(l);
        if (t) return t;
      }
      return input.placeholder || input.name || "";
    };
    const groupLabel = (el: Element): string => {
      const group = el.closest("fieldset,[role=radiogroup],[role=group]");
      if (group) {
        const legend = group.querySelector("legend");
        if (legend) return textOf(legend);
        const by = group.getAttribute("aria-labelledby");
        if (by) return textOf(document.getElementById(by));
        const aria = group.getAttribute("aria-label");
        if (aria) return aria;
      }
      const c = el.closest(".application-question,[class*='question'],.field,.form-group");
      if (c) return textOf(c.querySelector(".application-label,label,[class*='label']"));
      return (el as HTMLInputElement).name;
    };
    const optionLabel = (el: HTMLInputElement) =>
      (el.labels?.length ? textOf(el.labels[0]) : "") || el.getAttribute("aria-label") || el.value;
    const requiredOf = (el: Element, rawLabel: string) => {
      const c = container(el);
      return (
        (el as HTMLInputElement).required ||
        el.getAttribute("aria-required") === "true" ||
        /[*✱]/.test(rawLabel) ||
        Boolean(c?.querySelector(".required,[aria-required='true']"))
      );
    };
    const clean = (s: string) => s.replace(/[*✱]/g, " ").replace(/\s+/g, " ").trim();

    // Choose the form holding the application: prefer one with a file input, then the largest.
    const forms = [...document.querySelectorAll("form")];
    const score = (f: Element) => f.querySelectorAll("input,select,textarea").length + (f.querySelector("input[type=file]") ? 100 : 0);
    const scope: Element = forms.sort((a, b) => score(b) - score(a))[0] ?? document.body;

    const out: any[] = [];
    const groups = new Map<string, any>();
    const seen = new Set<Element>();
    for (const el of scope.querySelectorAll("input,select,textarea,[role=combobox]")) {
      if (seen.has(el)) continue;
      seen.add(el);
      const input = el as HTMLInputElement;
      const type = (input.type || "").toLowerCase();
      if (el.tagName === "INPUT" && ["hidden", "submit", "button", "reset", "image", "search"].includes(type)) continue;
      if (input.disabled) continue;

      if (type === "file") {
        // Upload buttons say "Attach"; the field's own heading says what to attach.
        const c = container(el);
        const raw = textOf(c?.querySelector("label,legend,[class*='label'],[class*='Label']") ?? null) || questionLabel(el);
        out.push({ rtId: tag(el), kind: "file", label: clean(raw), required: requiredOf(el, raw), options: [] });
        continue;
      }
      if (type === "radio" || type === "checkbox") {
        const host = el.closest("label") ?? el.parentElement ?? el;
        if (!visible(el) && !visible(host)) continue;
        const name = input.name || tag(el);
        const key = `${type}:${name}`;
        let g = groups.get(key);
        if (!g) {
          const raw = groupLabel(el) || optionLabel(input);
          g = { rtId: tag(el), kind: type, label: clean(raw), required: requiredOf(el, raw), options: [], optionIds: {} };
          groups.set(key, g);
          out.push(g);
        }
        const opt = clean(optionLabel(input));
        g.options.push(opt);
        g.optionIds[opt] = tag(el);
        continue;
      }
      if (!visible(el)) continue; // hidden text inputs are honeypots or framework internals
      const raw = questionLabel(el);
      const isCombo = el.getAttribute("role") === "combobox";
      const kind =
        el.tagName === "SELECT" ? "select" :
        el.tagName === "TEXTAREA" ? "textarea" :
        isCombo ? "combobox" :
        ["email", "tel", "url", "number", "date"].includes(type) ? type : "text";
      const options =
        el.tagName === "SELECT"
          ? [...(el as HTMLSelectElement).options]
              .filter((o) => o.value !== "" && !/^(select|choose|--|please select)/i.test(o.text.trim()))
              .map((o) => o.text.trim())
          : [];
      out.push({ rtId: tag(el), kind, label: clean(raw), required: requiredOf(el, raw), options });
    }
    // A lone checkbox is a yes/no field, not a group.
    for (const f of out) {
      if (f.kind === "checkbox" && f.options.length > 1) f.kind = "checkbox-group";
      if (f.kind === "checkbox" && f.options.length === 1 && (!f.label || f.label === f.options[0])) f.label = f.options[0];
    }
    return out;
  });

  // Custom dropdowns only reveal their options when opened.
  for (const f of fields.filter((x) => x.kind === "combobox")) {
    try {
      await page.locator(`[data-rt-id="${f.rtId}"]`).click({ timeout: 2000 });
      await page.waitForTimeout(300);
      f.options = (await comboOptions(page, f.rtId).allInnerTexts()).map((t) => t.trim()).filter(Boolean);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
    } catch {
      f.options = [];
    }
  }
  return fields;
}

/** The options of one open combobox, found through the listbox it points at. */
async function listboxFor(page: Page, rtId: string) {
  const id = await page
    .locator(`[data-rt-id="${rtId}"]`)
    .evaluate((el) => el.getAttribute("aria-controls") || el.getAttribute("aria-owns"));
  const scope = id ? page.locator(`[id="${id}"]`) : page.locator("[role=listbox]").filter({ visible: true }).last();
  return scope.locator("[role=option]");
}

export function comboOptions(page: Page, rtId: string) {
  return {
    allInnerTexts: async () => (await listboxFor(page, rtId)).allInnerTexts(),
    /** Clicks the option whose text matches exactly (or contains `text`); false when absent. */
    pick: async (text: string) => {
      const opts = await listboxFor(page, rtId);
      const texts = (await opts.allInnerTexts()).map((t) => t.trim());
      const i = texts.indexOf(text) >= 0 ? texts.indexOf(text) : texts.findIndex((t) => t.includes(text));
      if (i < 0) return false;
      await opts.nth(i).click();
      return true;
    },
  };
}
