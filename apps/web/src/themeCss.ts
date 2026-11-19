import { themeCssFetchCandidates, themeCssValueFetches } from "@t3tools/shared/themeCss";

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
 * The pending longhands of `style` that can fetch. cssText shows a pending shorthand's text until
 * a later declaration overrides one of its longhands. After that only the theme's source has the
 * text, so a longhand that does not come back from parsing cssText is judged by `hiddenFetches`.
 */
function fetchingPendingLonghands(
  style: CSSStyleDeclaration,
  hiddenFetches: (longhand: string) => boolean,
): string[] {
  const pending = pendingLonghands(style);
  if (pending.length === 0) return pending;
  const text = style.cssText;
  if (themeCssValueFetches(text)) return pending;
  const suspects = pending.filter(hiddenFetches);
  if (suspects.length === 0) return suspects;
  const shown = new Set(parsedStyles(`x{${text}}`).flatMap(pendingLonghands));
  return suspects.filter((longhand) => !shown.has(longhand));
}

/**
 * The longhands that a var() shorthand able to fetch leaves pending anywhere in the CSS. The
 * browser parses each candidate alone, as rules and as a block, so escapes resolve as they will.
 */
function fetchingShorthandLonghands(css: string): Set<string> {
  const longhands = new Set<string>();
  for (const candidate of themeCssFetchCandidates(css)) {
    for (const style of [...parsedStyles(candidate), ...parsedStyles(`x{${candidate}}`)]) {
      for (const longhand of fetchingPendingLonghands(style, () => true)) longhands.add(longhand);
    }
  }
  return longhands;
}

function stripDeclarations(rule: CSSRule, hiddenFetches: ReadonlySet<string>): boolean {
  if (!("style" in rule) || !(rule.style instanceof CSSStyleDeclaration)) return false;
  for (let item = rule.style.length - 1; item >= 0; item--) {
    const property = rule.style.item(item);
    if (themeCssValueFetches(rule.style.getPropertyValue(property))) {
      rule.style.removeProperty(property);
    }
  }
  const fetching = fetchingPendingLonghands(rule.style, (longhand) => hiddenFetches.has(longhand));
  for (const longhand of fetching) rule.style.removeProperty(longhand);
  return true;
}

/** Keeps only rule shapes it can check, so a new at-rule that fetches is dropped by default. */
function stripFetches(parent: RuleParent, hiddenFetches: ReadonlySet<string>): void {
  for (let index = parent.cssRules.length - 1; index >= 0; index--) {
    const rule = parent.cssRules[index];
    if (!rule) continue;
    const hasStyle = stripDeclarations(rule, hiddenFetches);
    if (rule instanceof CSSKeyframesRule) {
      for (const frame of rule.cssRules) stripDeclarations(frame, hiddenFetches);
    } else if (isRuleParent(rule)) {
      stripFetches(rule, hiddenFetches);
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
  stripFetches(themeSheet, fetchingShorthandLonghands(next));
}
