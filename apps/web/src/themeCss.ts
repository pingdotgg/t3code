import { themeCssValueFetches } from "@t3tools/shared/themeCss";

// Theme CSS comes from imported files and from agents, so it must not fetch: a
// url() on an attribute selector can send what is on screen to another host.
// The browser parses the text first, so the checks see normalized values and
// CSS escapes in a function name cannot dodge them.

let themeSheet: CSSStyleSheet | null = null;
let appliedCss = "";

function stripFetches(rules: CSSRuleList): void {
  for (const rule of rules) {
    if ("style" in rule && rule.style instanceof CSSStyleDeclaration) {
      const style = rule.style;
      for (let index = style.length - 1; index >= 0; index--) {
        const property = style.item(index);
        if (themeCssValueFetches(property, style.getPropertyValue(property))) {
          style.removeProperty(property);
        }
      }
    }
    if ("cssRules" in rule && rule.cssRules instanceof CSSRuleList) stripFetches(rule.cssRules);
  }
}

export function applyThemeCss(css: string | undefined): void {
  if (typeof document === "undefined" || typeof CSSStyleSheet === "undefined") return;
  const next = css ?? "";
  if (next === appliedCss) return;
  appliedCss = next;
  if (!themeSheet) {
    // Adopted sheets order after the document's own, and they cannot hold @import.
    themeSheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, themeSheet];
  }
  themeSheet.replaceSync(next);
  stripFetches(themeSheet.cssRules);
}
