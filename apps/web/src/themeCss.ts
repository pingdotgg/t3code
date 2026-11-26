import { themeCssValueFetches, themeCssWithoutDeclarations } from "@t3tools/shared/themeCss";

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

// A shorthand holding var() leaves its longhands reading "" until substitution.
function pendingLonghands(style: CSSStyleDeclaration): string[] {
  return Array.from(style).filter(
    (property) => !property.startsWith("--") && style.getPropertyValue(property) === "",
  );
}

/** Every declaration block the browser finds in `text`, parsed apart from the theme sheet. */
function parsedStyles(text: string): CSSStyleDeclaration[] {
  const styles: CSSStyleDeclaration[] = [];
  const collect = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if ("style" in rule && rule.style instanceof CSSStyleDeclaration) styles.push(rule.style);
      if ("cssRules" in rule && rule.cssRules instanceof CSSRuleList) collect(rule.cssRules);
    }
  };
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(text);
  collect(sheet.cssRules);
  return styles;
}

/**
 * Whether a shorthand that `style` leaves pending can fetch. cssText shows its text until a later
 * declaration overrides one of its longhands; `hiddenFetches` says what to make of one that then
 * does not come back from parsing cssText.
 */
function pendingShorthandFetches(style: CSSStyleDeclaration, hiddenFetches: boolean): boolean {
  const pending = pendingLonghands(style);
  if (pending.length === 0) return false;
  const text = style.cssText;
  if (themeCssValueFetches(text)) return true;
  if (!hiddenFetches) return false;
  const shown = new Set(parsedStyles(`x{${text}}`).flatMap(pendingLonghands));
  return pending.some((longhand) => !shown.has(longhand));
}

/**
 * The theme's source without the var() shorthands that can fetch, so that none is left for a later
 * declaration to hide. The browser parses each candidate alone, as rules and as a block, so
 * escapes resolve as they will.
 */
function withoutFetchingShorthands(css: string): string {
  return themeCssWithoutDeclarations(css, (candidate) =>
    [...parsedStyles(candidate), ...parsedStyles(`x{${candidate}}`)].some((style) =>
      pendingShorthandFetches(style, true),
    ),
  );
}

function stripDeclarations(rule: CSSRule): boolean {
  if (!("style" in rule) || !(rule.style instanceof CSSStyleDeclaration)) return false;
  for (let item = rule.style.length - 1; item >= 0; item--) {
    const property = rule.style.item(item);
    if (themeCssValueFetches(rule.style.getPropertyValue(property))) {
      rule.style.removeProperty(property);
    }
  }
  if (pendingShorthandFetches(rule.style, false)) {
    for (const longhand of pendingLonghands(rule.style)) rule.style.removeProperty(longhand);
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
  themeSheet.replaceSync(withoutFetchingShorthands(next));
  stripFetches(themeSheet);
}
