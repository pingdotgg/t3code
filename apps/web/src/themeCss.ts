import { themeCssValueFetches, themeCssVarBlockFetches } from "@t3tools/shared/themeCss";

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

function stripDeclarations(rule: CSSRule, varSourceFetches: boolean): boolean {
  if (!("style" in rule) || !(rule.style instanceof CSSStyleDeclaration)) return false;
  const pending: string[] = [];
  for (let item = rule.style.length - 1; item >= 0; item--) {
    const property = rule.style.item(item);
    const value = rule.style.getPropertyValue(property);
    // An empty custom property (`--on: ;`) is a real value, not a pending shorthand.
    if (value === "" && !property.startsWith("--")) pending.push(property);
    else if (themeCssValueFetches(value)) rule.style.removeProperty(property);
  }
  // A shorthand with var() leaves each longhand reading "". cssText shows the shorthand whole,
  // or, once another declaration overrides one longhand, lists the rest bare with its text hidden.
  // Only the theme's source still has that text, so a bare one goes when a var() block there fetches.
  const text = rule.style.cssText;
  const fetches = themeCssValueFetches(text);
  for (const property of pending) {
    if (fetches || (varSourceFetches && new RegExp(`(?:^|; )${property}:`).test(text))) {
      rule.style.removeProperty(property);
    }
  }
  return true;
}

/** Keeps only rule shapes it can check, so a new at-rule that fetches is dropped by default. */
function stripFetches(parent: RuleParent, varSourceFetches: boolean): void {
  for (let index = parent.cssRules.length - 1; index >= 0; index--) {
    const rule = parent.cssRules[index];
    if (!rule) continue;
    const hasStyle = stripDeclarations(rule, varSourceFetches);
    if (rule instanceof CSSKeyframesRule) {
      for (const frame of rule.cssRules) stripDeclarations(frame, varSourceFetches);
    } else if (isRuleParent(rule)) {
      stripFetches(rule, varSourceFetches);
    } else if (rule instanceof CSSPropertyRule) {
      // A registered property's initial value is used wherever var() reads it.
      if (themeCssValueFetches(rule.initialValue ?? "")) parent.deleteRule(index);
    } else if (
      !hasStyle &&
      !(rule instanceof CSSLayerStatementRule) &&
      // Names a namespace without loading it. CSSOM refuses to delete one while style rules remain.
      !(rule instanceof CSSNamespaceRule)
    ) {
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
  stripFetches(themeSheet, themeCssVarBlockFetches(next));
}
