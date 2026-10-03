import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderQuickSpec } from "./quick/render.mjs";

type VisualExplainerParams = {
  action: "prepare" | "render" | "render_quick";
  topic?: string;
  goal?: string;
  files?: string[];
  audience?: string;
  preferSubagent?: boolean;
  filename?: string;
  html?: string;
  spec?: unknown;
  open?: boolean;
  viewer?: Viewer;
};

type Viewer = "browser" | "glimpse" | "auto";
type OpenTarget = "browser" | "glimpse";
type OpenStatus = "disabled" | "unsupported" | "dispatched" | "failed";

type OpenResult = {
  openAttempted: boolean;
  openStatus: OpenStatus;
  openTarget?: OpenTarget;
  openError?: string;
  fallbackFrom?: OpenTarget;
  fallbackError?: string;
};

type SubagentDetection = {
  available: boolean;
  allToolsHasSubagent?: boolean;
  error?: string;
};

type PrepareDetails = {
  action: "prepare";
  topic: string;
  goal?: string;
  audience?: string;
  files: string[];
  subagentAvailable: boolean;
  subagentAllToolsAvailable?: boolean;
  subagentDetectionError?: string;
  recommendedFlow: string[];
  subagentPrompt?: string;
};

type RenderDetails = OpenResult & {
  action: "render" | "render_quick";
  path: string;
  viewer: Viewer;
};

type VisualExplainerDetails = PrepareDetails | RenderDetails;

const visualExplainerParameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["prepare", "render", "render_quick"],
      description:
        "Choose prepare to plan, render to write complete HTML, or render_quick to validate a compact spec and render it locally.",
    },
    topic: {
      type: "string",
      description: "For action=prepare: what the visual explanation should cover.",
    },
    goal: {
      type: "string",
      description: "For action=prepare: what the user wants to understand, decide, or communicate.",
    },
    files: {
      type: "array",
      items: { type: "string" },
      description:
        "For action=prepare: relevant files or paths the agent may inspect before generating the visual explanation.",
    },
    audience: {
      type: "string",
      description:
        "For action=prepare: intended audience, such as developer, PM, team, reviewer, or executive.",
    },
    preferSubagent: {
      type: "boolean",
      description:
        "For action=prepare: when true, recommend a scout subagent first if the subagent tool is active. Defaults to true.",
    },
    filename: {
      type: "string",
      description:
        "For action=render: basename or slug for the output file. The tool appends .html if missing.",
    },
    html: {
      type: "string",
      description: "For action=render: complete self-contained HTML document to write.",
    },
    spec: {
      type: "object",
      description: "For action=render_quick: compact JSON spec that follows quick/schema.json.",
      additionalProperties: true,
    },
    open: {
      type: "boolean",
      description:
        "For action=render or render_quick: open the written HTML file in the selected viewer. Defaults to true.",
    },
    viewer: {
      type: "string",
      enum: ["browser", "glimpse", "auto"],
      description:
        "For action=render or render_quick: choose browser, glimpse, or auto. Auto tries glimpseui first, then falls back to the browser. Defaults to browser.",
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

function detectSubagent(pi: ExtensionAPI): SubagentDetection {
  let error: string | undefined;

  try {
    return { available: pi.getActiveTools().includes("subagent") };
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  try {
    return {
      available: false,
      allToolsHasSubagent: pi.getAllTools().some((tool) => tool.name === "subagent"),
      error,
    };
  } catch (caught) {
    const fallbackError = caught instanceof Error ? caught.message : String(caught);
    return { available: false, error: error ? `${error}; ${fallbackError}` : fallbackError };
  }
}

function outputFilename(input: string) {
  const raw = input.trim().replace(/^@/, "");

  if (!raw) throw new Error("filename is required");
  if (raw.includes("/") || raw.includes("\\"))
    throw new Error("filename must be a basename, not a path");
  if (raw.includes("..")) throw new Error("filename must not contain '..'");
  if (/[\0-\x1f\x7f]/.test(raw)) throw new Error("filename must not contain control characters");

  return /\.html?$/i.test(raw) ? raw : `${raw}.html`;
}

function assertHtmlDocument(html: string) {
  const trimmed = html.trim();
  if (!trimmed) throw new Error("html is required");

  const start = trimmed
    .replace(/^\s*<!doctype\s+html\b[^>]*>\s*/i, "")
    .replace(/^(?:<!--[\s\S]*?-->\s*)+/, "");
  if (!/^<html[\s>]/i.test(start) || !/<\/html>\s*$/i.test(trimmed)) {
    throw new Error(
      "html must be a complete HTML document starting with <!doctype html> or <html> and ending with </html>",
    );
  }
}

const standardFavicon =
  "<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230f172a'/%3E%3Cpath d='M18 40V24l14-8 14 8v16l-14 8-14-8Z' fill='none' stroke='%23fbbf24' stroke-width='4' stroke-linejoin='round'/%3E%3Ccircle cx='32' cy='32' r='5' fill='%2338bdf8'/%3E%3C/svg%3E\">";

function escapeDisplayMath(html: string) {
  return html.replace(
    /\$\$([\s\S]*?)\$\$/g,
    (_match, math: string) => `$$${math.replace(/</g, "&lt;").replace(/>/g, "&gt;")}$$`,
  );
}

function ensureFavicon(html: string) {
  if (/<link\b[^>]*\brel=["'][^"']*(?:icon|shortcut icon)[^"']*["'][^>]*>/i.test(html)) return html;
  if (/<\/title>/i.test(html)) return html.replace(/<\/title>/i, `</title>\n${standardFavicon}`);
  if (/<head[^>]*>/i.test(html))
    return html.replace(/<head[^>]*>/i, (head) => `${head}\n${standardFavicon}`);
  return html.replace(
    /<html[^>]*>/i,
    (htmlTag) => `${htmlTag}\n<head>\n${standardFavicon}\n</head>`,
  );
}

function ensureDocumentMetadata(html: string) {
  let output = html;
  if (!/<html\b[^>]*\blang\s*=/i.test(output))
    output = output.replace(/<html\b/i, '<html lang="en"');
  if (!/<head[^>]*>/i.test(output))
    output = output.replace(/<html[^>]*>/i, (htmlTag) => `${htmlTag}\n<head></head>`);
  if (!/<meta\b[^>]*\bname\s*=\s*["']viewport["'][^>]*>/i.test(output)) {
    output = output.replace(
      /<head[^>]*>/i,
      (head) => `${head}\n<meta name="viewport" content="width=device-width, initial-scale=1.0">`,
    );
  }
  return output;
}

function prepareRenderedHtml(html: string) {
  return ensureDocumentMetadata(ensureFavicon(escapeDisplayMath(html)));
}

function runOpener(command: string, args: string[], openTarget: OpenTarget): Promise<OpenResult> {
  return new Promise<OpenResult>((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    let settled = false;

    const settle = (result: OpenResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.once("error", (error) => {
      settle({
        openAttempted: true,
        openStatus: "failed",
        openTarget,
        openError: error.message,
      });
    });

    child.once("exit", (code, signal) => {
      if (code !== 0) {
        settle({
          openAttempted: true,
          openStatus: "failed",
          openTarget,
          openError:
            code === null
              ? `opener exited with signal ${signal ?? "unknown"}`
              : `opener exited with code ${code}`,
        });
      }
    });

    const timer = setTimeout(() => {
      settle({ openAttempted: true, openStatus: "dispatched", openTarget });
    }, 250);

    child.unref();
  });
}

async function openInBrowser(path: string): Promise<OpenResult> {
  if (process.platform === "darwin") return await runOpener("open", [path], "browser");
  if (process.platform === "linux") return await runOpener("xdg-open", [path], "browser");
  if (process.platform === "win32")
    return await runOpener("cmd", ["/c", "start", "", path], "browser");
  return { openAttempted: false, openStatus: "unsupported", openTarget: "browser" };
}

async function openInGlimpse(path: string): Promise<OpenResult> {
  return await runOpener(
    "glimpseui",
    ["--width", "1200", "--height", "900", "--title", "Visual Explainer", "--open-links", path],
    "glimpse",
  );
}

async function openRenderedPage(path: string, viewer: Viewer): Promise<OpenResult> {
  if (viewer === "browser") return await openInBrowser(path);
  if (viewer === "glimpse") return await openInGlimpse(path);

  const glimpseResult = await openInGlimpse(path);
  if (glimpseResult.openStatus !== "failed") return glimpseResult;

  const browserResult = await openInBrowser(path);
  return {
    ...browserResult,
    fallbackFrom: "glimpse",
    fallbackError: glimpseResult.openError ?? "glimpseui failed",
  };
}

function prepareVisualExplanation(
  pi: ExtensionAPI,
  params: VisualExplainerParams,
): AgentToolResult<VisualExplainerDetails> {
  if (typeof params.topic !== "string")
    throw new Error("topic must be a string for action=prepare");
  if (params.goal !== undefined && typeof params.goal !== "string")
    throw new Error("goal must be a string when provided");
  if (params.audience !== undefined && typeof params.audience !== "string")
    throw new Error("audience must be a string when provided");
  if (
    params.files !== undefined &&
    (!Array.isArray(params.files) || !params.files.every((file) => typeof file === "string"))
  ) {
    throw new Error("files must be an array of strings when provided");
  }
  if (params.preferSubagent !== undefined && typeof params.preferSubagent !== "boolean") {
    throw new Error("preferSubagent must be a boolean when provided");
  }

  const topic = params.topic.trim();
  if (!topic) throw new Error("topic is required");

  const goal = params.goal?.trim();
  const audience = params.audience?.trim();
  const files = params.files?.map((file) => file.trim()).filter(Boolean) ?? [];
  const subagent = detectSubagent(pi);
  const shouldUseSubagent = params.preferSubagent !== false && subagent.available;
  const subagentPrompt = shouldUseSubagent
    ? `Scout the codebase for a visual explanation about ${topic}.${goal ? ` The user goal is: ${goal}.` : ""}${files.length ? ` Start with these files/paths: ${files.join(", ")}.` : ""} Return concise findings, important entities/flows, and visual structure recommendations. Do not edit files.`
    : undefined;
  const recommendedFlow = shouldUseSubagent
    ? [
        "Run a scout subagent to gather repo context and identify the visual structure.",
        "Synthesize the findings into a concise visual outline for the target audience.",
        "Read the relevant visual-explainer references or templates before generating the page.",
        "Generate a complete self-contained HTML document using the visual-explainer skill.",
        "Choose a basename filename and call visual_explainer with action=render, filename, html, optional open, and optional viewer.",
      ]
    : [
        "Gather the needed context directly in the main agent.",
        "Create a concise visual outline for the target audience.",
        "Read the relevant visual-explainer references or templates before generating the page.",
        "Generate a complete self-contained HTML document using the visual-explainer skill.",
        "Choose a basename filename and call visual_explainer with action=render, filename, html, optional open, and optional viewer.",
      ];

  const summaryLines = [
    `Prepared visual explanation for: ${topic}`,
    goal ? `Goal: ${goal}` : undefined,
    audience ? `Audience: ${audience}` : undefined,
    shouldUseSubagent
      ? "Recommended start: use a scout subagent for context."
      : "Recommended start: gather context directly in this session.",
    "Recommended flow:",
    ...recommendedFlow.map((step, i) => `${i + 1}. ${step}`),
    subagentPrompt ? `Suggested subagent task:\n${subagentPrompt}` : undefined,
  ];

  return {
    content: [
      {
        type: "text" as const,
        text: summaryLines.filter((line): line is string => Boolean(line)).join("\n"),
      },
    ],
    details: {
      action: "prepare",
      topic,
      goal,
      audience,
      files,
      subagentAvailable: subagent.available,
      subagentAllToolsAvailable: subagent.allToolsHasSubagent,
      subagentDetectionError: subagent.error,
      recommendedFlow,
      subagentPrompt,
    },
  };
}

async function writeRenderedHtml(
  action: "render" | "render_quick",
  filenameInput: string,
  htmlInput: string,
  open: boolean | undefined,
  viewer: Viewer,
  signal?: AbortSignal,
): Promise<AgentToolResult<VisualExplainerDetails>> {
  signal?.throwIfAborted();

  const filename = outputFilename(filenameInput);
  assertHtmlDocument(htmlInput);
  const html = prepareRenderedHtml(htmlInput);
  const outputDir = join(homedir(), ".agent", "diagrams");
  const outputPath = join(outputDir, filename);
  if (existsSync(outputDir) && lstatSync(outputDir).isSymbolicLink())
    throw new Error(`${outputDir} must not be a symlink`);
  mkdirSync(outputDir, { recursive: true });
  if (existsSync(outputPath) && lstatSync(outputPath).isSymbolicLink()) {
    throw new Error(`${outputPath} must not be a symlink`);
  }

  signal?.throwIfAborted();
  writeFileSync(outputPath, html, "utf8");

  signal?.throwIfAborted();

  const openResult =
    open === false
      ? { openAttempted: false, openStatus: "disabled" as const }
      : await openRenderedPage(outputPath, viewer);

  let message = `Wrote ${outputPath}.`;
  if (openResult.openStatus === "dispatched") {
    message += ` ${openResult.openTarget === "glimpse" ? "Glimpse" : "Browser"} open requested.`;
  } else if (openResult.openStatus === "failed") {
    message += ` ${openResult.openTarget === "glimpse" ? "Glimpse" : "Browser"} open failed: ${openResult.openError ?? "unknown error"}.`;
  } else if (openResult.openStatus === "unsupported") {
    message += " Browser opening is unsupported on this platform.";
  }
  if (openResult.fallbackFrom === "glimpse") {
    message += ` Glimpse fallback reason: ${openResult.fallbackError ?? "unknown error"}.`;
  }

  return {
    content: [{ type: "text" as const, text: message }],
    details: { action, path: outputPath, viewer, ...openResult },
  };
}

function validateRenderOptions(
  params: VisualExplainerParams,
): asserts params is VisualExplainerParams & { filename: string } {
  if (typeof params.filename !== "string")
    throw new Error(`filename must be a string for action=${params.action}`);
  if (params.open !== undefined && typeof params.open !== "boolean")
    throw new Error("open must be a boolean when provided");
  if (
    params.viewer !== undefined &&
    params.viewer !== "browser" &&
    params.viewer !== "glimpse" &&
    params.viewer !== "auto"
  ) {
    throw new Error("viewer must be browser, glimpse, or auto when provided");
  }
}

async function renderVisualExplanation(
  params: VisualExplainerParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<VisualExplainerDetails>> {
  validateRenderOptions(params);
  if (typeof params.html !== "string") throw new Error("html must be a string for action=render");
  return await writeRenderedHtml(
    "render",
    params.filename,
    params.html,
    params.open,
    params.viewer ?? "browser",
    signal,
  );
}

async function renderQuickVisualExplanation(
  params: VisualExplainerParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<VisualExplainerDetails>> {
  validateRenderOptions(params);
  if (params.spec === undefined) throw new Error("spec is required for action=render_quick");
  signal?.throwIfAborted();
  const html = await renderQuickSpec(params.spec);
  return await writeRenderedHtml(
    "render_quick",
    params.filename,
    html,
    params.open,
    params.viewer ?? "browser",
    signal,
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerTool<typeof visualExplainerParameters, VisualExplainerDetails>({
    name: "visual_explainer",
    label: "Visual Explainer",
    description:
      "Plan visual explanations, write complete HTML, or validate and locally render a compact quick spec to ~/.agent/diagrams/.",
    promptSnippet:
      "Plan or render visual-explainer HTML. Use render for complete HTML and render_quick only for an explicit supported --quick prompt.",
    promptGuidelines: [
      "After generating or reviewing a plan, architecture, diff, or substantial implementation, consider offering a visual explanation if it would clarify the work for the user.",
      "Because visual explanations can consume many tokens, ask before calling visual_explainer with action=prepare unless the user explicitly requested a diagram, visual review, recap, or visual plan.",
      "If visual_explainer action=prepare recommends subagent scouting and the subagent tool is available, gather context first, then synthesize complete HTML and finish with visual_explainer action=render.",
      "Use visual_explainer action=render only after generating a complete visual-explainer HTML document; pass a basename-style filename because it writes under ~/.agent/diagrams/. Use viewer=glimpse only when the user wants a native Glimpse window and glimpseui is installed; viewer=auto may fall back to the browser.",
      "Use action=render_quick only when --quick is explicit on generate-web-diagram, diff-review, plan-review, or project-recap. Pass the compact schema spec. If it fails or does not fit, use the full HTML workflow and action=render.",
    ],
    parameters: visualExplainerParameters,
    executionMode: "sequential",
    async execute(_toolCallId: string, params: VisualExplainerParams, signal?: AbortSignal) {
      if (
        params.action !== "prepare" &&
        params.action !== "render" &&
        params.action !== "render_quick"
      ) {
        throw new Error("action must be 'prepare', 'render', or 'render_quick'");
      }

      if (params.action === "prepare") return prepareVisualExplanation(pi, params);
      if (params.action === "render_quick")
        return await renderQuickVisualExplanation(params, signal);
      return await renderVisualExplanation(params, signal);
    },
  });
}
