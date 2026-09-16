import { isWorkspaceHtmlPath } from "@t3tools/contracts";

interface ExpandDesignCommandInput {
  prompt: string;
  threadId: string;
}

export function designPathFromUrl(url: string, assetBaseUrl: string): string | null {
  try {
    const parsed = new URL(url);
    if (
      parsed.origin !== new URL(assetBaseUrl).origin ||
      !parsed.pathname.startsWith("/api/assets/") ||
      !parsed.searchParams.has("t3-design")
    )
      return null;
    const path = parsed.searchParams.get("t3-design-path");
    return path && isWorkspaceHtmlPath(path) ? path : null;
  } catch {
    return null;
  }
}

const DESIGN_REQUEST_PATTERN =
  /^([\s\S]*?)<t3_design_request>\n\n<original>([\s\S]*?)<\/original>\n\n[\s\S]*?\n\n<\/t3_design_request>([\s\S]*)$/;

const DESIGN_CONTEXT_PATTERN =
  /\n*<t3_design_context>\n\n<paths>\n[\s\S]*?\n\n<\/t3_design_context>/g;

const escapeXml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const unescapeXml = (value: string): string =>
  value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

const DESIGN_CRAFT_RULES = [
  "Design craft rules, same for every model:",
  "Start from the brief: name the audience, the one job each screen does, and the product's existing tokens, fonts, and components. Reuse them before inventing.",
  "Pick one clear direction per artboard and state it in a short caption at the top of the artboard, for example warm editorial, dense data, playful, quiet monochrome. Vary layout and hierarchy across artboards, not only colour.",
  "Typography: at most two families, a 4 to 6 step scale, tight line-height on headings, 1.5 on body, never default browser fonts. Real copy that fits the product, no lorem ipsum.",
  "Spacing on an 8px grid with a 4px half step. Consistent padding inside cards and controls. Generous whitespace around the hero of each screen.",
  "Colour: one accent, neutrals with clear steps, 4.5:1 contrast for text, visible focus rings, hover and pressed states for every control.",
  "Depth: subtle borders or one soft shadow level. No stacked cards inside cards, no gradients or glows unless the brief asks for them.",
  "Components: real states (default, hover, active, disabled, empty, loading, error) where the screen needs them. Icons as inline SVG, 16 or 20px, 1.5 to 2 stroke.",
  "Layout: mobile and desktop both plausible; fixed artboard sizes of 1440x900 for desktop and 390x844 for mobile unless the brief says otherwise. Align everything; no orphan elements.",
  "Every artboard is self-contained HTML plus CSS in one file, no external assets, no scripts, no frameworks. Keep the DOM shallow and give meaningful data-t3-design-id names such as hero-title or primary-cta.",
  "Before finishing, check each artboard against these rules and fix misses. Then write one line per artboard explaining the direction and when to choose it.",
].join("\n");

export function expandDesignCommand({ prompt, threadId }: ExpandDesignCommandInput): string {
  const match = /^\/design\s+([\s\S]*\S)\s*$/i.exec(prompt);
  if (!match) return prompt;
  const brief = match[1]!;
  const path = `.t3/designs/${threadId}.html`;
  return [
    "<t3_design_request>",
    `<original>${escapeXml(prompt)}</original>`,
    `Design ${escapeXml(brief)}`,
    "Create four distinct artboards before implementing any production code.",
    `Build them as one self-contained HTML document at ${path}.`,
    "Render the design with HTML, CSS, and inline SVG. The editing canvas does not execute page scripts.",
    "Use the product's existing visual language when the workspace has one. Make every artboard polished, responsive, accessible, and meaningfully different.",
    "Write the document early, call design_open with its workspace-relative path, then keep updating the same file and call design_open after each meaningful visual pass so the user can watch it develop.",
    "Give each artboard a stable data-t3-design-artboard and data-t3-design-id attribute. Give important child elements stable data-t3-design-id attributes.",
    "Treat data-t3-design-selected as the preferred artboard and persistent manual objects, notes, drawings, text, and inline styles as user edits. Reread this file before every design or implementation change without asking for an attachment.",
    "Do not start implementation until the user selects a direction.",
    DESIGN_CRAFT_RULES,
    "</t3_design_request>",
  ].join("\n\n");
}

export function appendDesignContext(
  prompt: string,
  designs: ReadonlyArray<{ path: string }>,
): string {
  if (designs.length === 0 || DESIGN_REQUEST_PATTERN.test(prompt)) return prompt;
  return [
    prompt,
    [
      "<t3_design_context>",
      `<paths>\n${designs.map((design) => escapeXml(design.path)).join("\n")}\n</paths>`,
      "The user is working in the design canvas. Reread each listed file before answering or changing code; do not ask for an attachment. data-t3-design-selected marks the artboard the user chose, and inline styles, notes, drawings, and text are user edits. Element attachments added to chat identify the selected elements. When the user refers to a direction or artboard by name, match it to data-t3-design-artboard. When you change or add designs, follow the rules below.",
      DESIGN_CRAFT_RULES,
      "</t3_design_context>",
    ].join("\n\n"),
  ].join("\n\n");
}

export function visibleDesignCommand(prompt: string): string {
  const context = [...prompt.matchAll(DESIGN_CONTEXT_PATTERN)].at(-1);
  const withoutContext = context
    ? prompt.slice(0, context.index) + prompt.slice(context.index + context[0].length)
    : prompt;
  const match = DESIGN_REQUEST_PATTERN.exec(withoutContext);
  return match
    ? `${match[1] ?? ""}${unescapeXml(match[2] ?? "")}${match[3] ?? ""}`
    : withoutContext;
}
