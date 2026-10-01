#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { renderQuickSpec } from "../quick/render.mjs";

const serverPath = fileURLToPath(import.meta.url);
const mcpDir = dirname(serverPath);
const skillDir = dirname(mcpDir);
const rootDir = join(skillDir, "..", "..");
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));

const viewerSchema = z.enum(["browser", "glimpse", "auto"]);
const openStatusSchema = z.enum(["disabled", "unsupported", "dispatched", "failed"]);
const openTargetSchema = z.enum(["browser", "glimpse"]);

const prepareInputSchema = z
  .object({
    topic: z.string().min(1).describe("What the visual explanation should cover."),
    goal: z
      .string()
      .optional()
      .describe("What the user wants to understand, decide, or communicate."),
    files: z
      .array(z.string())
      .optional()
      .describe("Relevant files or paths the host model should inspect."),
    audience: z
      .string()
      .optional()
      .describe("Intended audience, such as developer, PM, team, reviewer, or executive."),
  })
  .strict();

const prepareOutputSchema = z.object({
  topic: z.string(),
  goal: z.string().optional(),
  audience: z.string().optional(),
  files: z.array(z.string()),
  recommendedFlow: z.array(z.string()),
});

const renderInputSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .describe(
        "Basename filename. The server appends .html when no .html/.htm suffix is present.",
      ),
    html: z.string().min(1).describe("Complete self-contained HTML document."),
    open: z
      .boolean()
      .default(false)
      .describe("Open the written file after rendering. Defaults to false for MCP."),
    viewer: viewerSchema.default("browser").describe("Viewer to use when open is true."),
  })
  .strict();

const renderQuickInputSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .describe(
        "Basename filename. The server appends .html when no .html/.htm suffix is present.",
      ),
    spec: z
      .unknown()
      .describe("Compact JSON spec that follows visual-explainer quick/schema.json."),
    open: z
      .boolean()
      .default(false)
      .describe("Open the written file after rendering. Defaults to false for MCP."),
    viewer: viewerSchema.default("browser").describe("Viewer to use when open is true."),
  })
  .strict();

const renderOutputSchema = z.object({
  path: z.string(),
  viewer: viewerSchema,
  openAttempted: z.boolean(),
  openStatus: openStatusSchema,
  openTarget: openTargetSchema.optional(),
  openError: z.string().optional(),
  fallbackFrom: openTargetSchema.optional(),
  fallbackError: z.string().optional(),
});

const promptArgsSchema = z
  .object({
    request: z
      .string()
      .optional()
      .describe(
        "User-supplied prompt arguments. This replaces $@ in the bundled command template.",
      ),
  })
  .strict();

const promptFiles = [
  "diff-review.md",
  "fact-check.md",
  "generate-slides.md",
  "generate-visual-plan.md",
  "generate-web-diagram.md",
  "plan-review.md",
  "project-recap.md",
];

const resourceFiles = [
  {
    name: "skill",
    uri: "visual-explainer://skill/SKILL.md",
    path: "SKILL.md",
    title: "Visual Explainer Skill",
    mimeType: "text/markdown",
  },
  {
    name: "quick-readme",
    uri: "visual-explainer://quick/README.md",
    path: "quick/README.md",
    title: "Quick Mode README",
    mimeType: "text/markdown",
  },
  {
    name: "quick-schema",
    uri: "visual-explainer://quick/schema.json",
    path: "quick/schema.json",
    title: "Quick Mode JSON Schema",
    mimeType: "application/schema+json",
  },
];

function readSkillFile(relativePath) {
  return readFileSync(join(skillDir, relativePath), "utf8");
}

function parsePromptFile(relativePath) {
  const text = readSkillFile(relativePath);
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    const name = relativePath.split("/").pop()?.replace(/\.md$/, "") ?? relativePath;
    return { name, description: `Visual Explainer prompt from ${relativePath}.`, body: text };
  }

  const frontmatter = match[1];
  const body = match[2];
  const name =
    frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() ??
    relativePath.split("/").pop()?.replace(/\.md$/, "") ??
    relativePath;
  const description =
    frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() ??
    `Visual Explainer prompt from ${relativePath}.`;
  return { name, description, body };
}

function outputFilename(input) {
  if (/[\0-\x1f\x7f]/.test(input)) throw new Error("filename must not contain control characters");

  const raw = input.replace(/^@/, "").trim();

  if (!raw) throw new Error("filename is required");
  if (raw.includes("/") || raw.includes("\\"))
    throw new Error("filename must be a basename, not a path");
  if (raw.includes("..")) throw new Error("filename must not contain '..'");

  return /\.html?$/i.test(raw) ? raw : `${raw}.html`;
}

function resolveOutputDirectory() {
  const configured = process.env.VISUAL_EXPLAINER_OUTPUT_DIR?.trim();
  return {
    path: configured ? resolve(configured) : join(homedir(), ".agent", "diagrams"),
    configured: Boolean(configured),
  };
}

function assertOutputPathContained(resolvedDir, outputPath) {
  const resolvedPath = resolve(outputPath);
  const dirPrefix = resolvedDir.endsWith(sep) ? resolvedDir : `${resolvedDir}${sep}`;
  if (resolvedPath !== resolvedDir && !resolvedPath.startsWith(dirPrefix)) {
    throw new Error(`${outputPath} must stay inside ${resolvedDir}`);
  }
}

function writeRenderedFile(outputPath, html) {
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, html, { encoding: "utf8", flag: "wx", mode: 0o666 });
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    throw error;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function assertHtmlDocument(html) {
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

function escapeDisplayMath(html) {
  return html.replace(
    /\$\$([\s\S]*?)\$\$/g,
    (_match, math) => `$$${math.replace(/</g, "&lt;").replace(/>/g, "&gt;")}$$`,
  );
}

function ensureFavicon(html) {
  if (/<link\b[^>]*\brel=["'][^"']*(?:icon|shortcut icon)[^"']*["'][^>]*>/i.test(html)) return html;
  if (/<\/title>/i.test(html)) return html.replace(/<\/title>/i, `</title>\n${standardFavicon}`);
  if (/<head[^>]*>/i.test(html))
    return html.replace(/<head[^>]*>/i, (head) => `${head}\n${standardFavicon}`);
  return html.replace(
    /<html[^>]*>/i,
    (htmlTag) => `${htmlTag}\n<head>\n${standardFavicon}\n</head>`,
  );
}

function ensureDocumentMetadata(html) {
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

function prepareRenderedHtml(html) {
  return ensureDocumentMetadata(ensureFavicon(escapeDisplayMath(html)));
}

function runOpener(command, args, openTarget) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    let settled = false;

    const settle = (result) => {
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

async function openInBrowser(path) {
  if (process.platform === "darwin") return await runOpener("open", [path], "browser");
  if (process.platform === "linux") return await runOpener("xdg-open", [path], "browser");
  if (process.platform === "win32")
    return await runOpener("cmd", ["/c", "start", "", path], "browser");
  return { openAttempted: false, openStatus: "unsupported", openTarget: "browser" };
}

async function openInGlimpse(path) {
  return await runOpener(
    "glimpseui",
    ["--width", "1200", "--height", "900", "--title", "Visual Explainer", "--open-links", path],
    "glimpse",
  );
}

async function openRenderedPage(path, viewer) {
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

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

function renderToolResult(message, structuredContent) {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: compact(structuredContent),
  };
}

function renderToolError(error) {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

function prepareVisualExplanation(params) {
  const topic = params.topic.trim();
  if (!topic) throw new Error("topic is required");

  const goal = params.goal?.trim();
  const audience = params.audience?.trim();
  const files = params.files?.map((file) => file.trim()).filter(Boolean) ?? [];
  const recommendedFlow = [
    "Use the visual-explainer prompt or skill resources to choose the page shape.",
    "Gather and verify the source facts in the host model. The MCP server does not call an LLM.",
    "For custom output, generate a complete self-contained HTML document and call visual_explainer_render_html.",
    "For explicit quick mode, build a compact spec that follows visual-explainer://quick/schema.json and call visual_explainer_render_quick.",
    "Keep output filenames as basenames. The MCP server writes only inside its configured output directory (default ~/.agent/diagrams/).",
  ];

  const structuredContent = { topic, goal, audience, files, recommendedFlow };
  const message = [
    `Prepared visual explanation for: ${topic}`,
    goal ? `Goal: ${goal}` : undefined,
    audience ? `Audience: ${audience}` : undefined,
    files.length ? `Starting files: ${files.join(", ")}` : undefined,
    "Recommended flow:",
    ...recommendedFlow.map((step, index) => `${index + 1}. ${step}`),
  ]
    .filter(Boolean)
    .join("\n");

  return renderToolResult(message, structuredContent);
}

async function writeRenderedHtml(filenameInput, htmlInput, open, viewer) {
  const filename = outputFilename(filenameInput);
  assertHtmlDocument(htmlInput);
  const html = prepareRenderedHtml(htmlInput);
  const { path: outputDir, configured } = resolveOutputDirectory();
  const outputPath = join(outputDir, filename);

  const outputDirStatus = lstatSync(outputDir, { throwIfNoEntry: false });
  if (outputDirStatus?.isSymbolicLink()) throw new Error(`${outputDir} must not be a symlink`);
  mkdirSync(outputDir, { recursive: true });

  const resolvedDir = realpathSync(outputDir);
  if (configured && resolvedDir !== outputDir) {
    throw new Error(`${outputDir} must not contain symlinks and must resolve to itself`);
  }
  assertOutputPathContained(resolvedDir, join(resolvedDir, filename));

  const outputStatus = lstatSync(outputPath, { throwIfNoEntry: false });
  if (outputStatus?.isSymbolicLink()) throw new Error(`${outputPath} must not be a symlink`);

  writeRenderedFile(outputPath, html);

  const openResult = open
    ? await openRenderedPage(outputPath, viewer)
    : { openAttempted: false, openStatus: "disabled" };
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

  return { message, output: compact({ path: outputPath, viewer, ...openResult }) };
}

function registerResources(server) {
  for (const resource of resourceFiles) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: `Bundled visual-explainer resource: ${resource.path}`,
        mimeType: resource.mimeType,
      },
      async (uri) => ({
        contents: [
          { uri: uri.href, mimeType: resource.mimeType, text: readSkillFile(resource.path) },
        ],
      }),
    );
  }

  for (const file of promptFiles) {
    const relativePath = `commands/${file}`;
    const prompt = parsePromptFile(relativePath);
    server.registerResource(
      `command-${prompt.name}`,
      `visual-explainer://commands/${file}`,
      {
        title: `/${prompt.name}`,
        description: prompt.description,
        mimeType: "text/markdown",
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: readSkillFile(relativePath) }],
      }),
    );
  }
}

function registerPrompts(server) {
  for (const file of promptFiles) {
    const prompt = parsePromptFile(`commands/${file}`);
    server.registerPrompt(
      prompt.name,
      {
        title: `/${prompt.name}`,
        description: prompt.description,
        argsSchema: promptArgsSchema,
      },
      ({ request }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: prompt.body.replaceAll("$@", request ?? "").trim(),
            },
          },
        ],
      }),
    );
  }
}

function registerTools(server) {
  server.registerTool(
    "visual_explainer_prepare",
    {
      title: "Prepare Visual Explainer",
      description: "Plan a visual explanation. Does not call an LLM or write files.",
      inputSchema: prepareInputSchema,
      outputSchema: prepareOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return prepareVisualExplanation(params);
      } catch (error) {
        return renderToolError(error);
      }
    },
  );

  server.registerTool(
    "visual_explainer_render_html",
    {
      title: "Render Visual Explainer HTML",
      description:
        "Validate and write a complete self-contained HTML document to the configured output directory (default ~/.agent/diagrams/). Does not call an LLM.",
      inputSchema: renderInputSchema,
      outputSchema: renderOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ filename, html, open, viewer }) => {
      try {
        const result = await writeRenderedHtml(filename, html, open, viewer);
        return renderToolResult(result.message, result.output);
      } catch (error) {
        return renderToolError(error);
      }
    },
  );

  server.registerTool(
    "visual_explainer_render_quick",
    {
      title: "Render Visual Explainer Quick Spec",
      description:
        "Validate a quick-mode JSON spec and render it to the configured output directory (default ~/.agent/diagrams/). Does not call an LLM.",
      inputSchema: renderQuickInputSchema,
      outputSchema: renderOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ filename, spec, open, viewer }) => {
      try {
        const html = await renderQuickSpec(spec);
        const result = await writeRenderedHtml(filename, html, open, viewer);
        return renderToolResult(result.message, result.output);
      } catch (error) {
        return renderToolError(error);
      }
    },
  );
}

export function createServer() {
  const server = new McpServer({ name: "visual-explainer", version: packageJson.version });
  registerResources(server);
  registerPrompts(server);
  registerTools(server);
  return server;
}

function isMainModule() {
  return Boolean(process.argv[1] && realpathSync(process.argv[1]) === serverPath);
}

if (isMainModule()) {
  const handle = serveStdio(createServer);
  console.error("visual-explainer MCP server running on stdio");

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      void handle.close().finally(() => process.exit(0));
    });
  }
}
