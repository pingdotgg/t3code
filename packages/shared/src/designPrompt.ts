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

const escapeXml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const unescapeXml = (value: string): string =>
  value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

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
    "Use the product's existing visual language when the workspace has one. Make every artboard polished, responsive, accessible, and meaningfully different.",
    "Write the document early, call design_open with its workspace-relative path, then keep updating the same file and call design_open after each meaningful visual pass so the user can watch it develop.",
    "Give each artboard a stable data-t3-design-artboard and data-t3-design-id attribute. Give important child elements stable data-t3-design-id attributes.",
    "Treat data-t3-design-selected as the preferred artboard, data-t3-design-focus as the current element, and persistent manual objects, notes, drawings, text, and inline styles as user edits. Reread this file before every design or implementation change without asking for an attachment.",
    "Do not start implementation until the user selects a direction.",
    "</t3_design_request>",
  ].join("\n\n");
}

export function visibleDesignCommand(prompt: string): string {
  const match = DESIGN_REQUEST_PATTERN.exec(prompt);
  return match ? `${match[1] ?? ""}${unescapeXml(match[2] ?? "")}${match[3] ?? ""}` : prompt;
}
