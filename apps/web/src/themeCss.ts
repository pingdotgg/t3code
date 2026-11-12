import { themeCssValueFetches } from "@t3tools/shared/themeCss";

// Theme CSS comes from imported files and from agents, so it must not fetch: a
// url() on an attribute selector can send what is on screen to another host.
// The browser parses the text first, so the checks see normalized values and
// CSS escapes in a function name cannot dodge them.

let themeSheet: CSSStyleSheet | null = null;
let appliedCss = "";

type RuleParent = Pick<CSSStyleSheet, "cssRules" | "deleteRule">;

// @keyframes also has both members, but its deleteRule takes a keyframe selector.
const isRuleParent = (rule: CSSRule): rule is CSSRule & RuleParent =>
  "cssRules" in rule && "deleteRule" in rule && !(rule instanceof CSSKeyframesRule);

function stripDeclarations(rule: CSSRule): boolean {
  if (!("style" in rule) || !(rule.style instanceof CSSStyleDeclaration)) return false;
  for (let item = rule.style.length - 1; item >= 0; item--) {
    const property = rule.style.item(item);
    if (themeCssValueFetches(rule.style.getPropertyValue(property))) {
      rule.style.removeProperty(property);
    }
  }
  return true;
}

/** Keeps only rule shapes it can check, so a new at-rule that fetches is dropped by default. */
function stripFetches(parent: RuleParent): void {
  for (let index = parent.cssRules.length - 1; index >= 0; index--) {
    const rule = parent.cssRules[index];
    if (!rule) continue;
    const hasStyle = stripDeclarations(rule);
    if (rule instanceof CSSKeyframesRule) {
      for (const frame of rule.cssRules) stripDeclarations(frame);
    } else if (isRuleParent(rule)) {
      stripFetches(rule);
    } else if (rule instanceof CSSPropertyRule) {
      // A registered property's initial value is used wherever var() reads it.
      if (themeCssValueFetches(rule.initialValue ?? "")) parent.deleteRule(index);
    } else if (!hasStyle && !(rule instanceof CSSLayerStatementRule)) {
      parent.deleteRule(index);
    }
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
  stripFetches(themeSheet);
}
