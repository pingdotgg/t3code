import {
  applyRuns,
  CopyEditError,
  markdownDialect,
  markdownRuns,
  type CopyEditHandler,
  type MarkdownOptions,
  type MarkdownStyle,
} from "@alchemy.run/vite-plugin-copy-editor";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  docCommentLines,
  docTargets,
  JSDOC_LINE_PREFIX,
  linkTagText,
  parseJsdocCopyId,
  regionSource,
  replaceRegion,
} from "../../scripts/jsdoc-blocks.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const generator = path.join(repoRoot, "scripts/generate-api-reference.ts");

const markdown: MarkdownOptions = {
  linePrefix: JSDOC_LINE_PREFIX,
  atomics: [
    { pattern: /\{@link\s+([^}]+)\}/, text: (m) => linkTagText(m[1]!) },
  ],
};
const dialect = markdownDialect(markdown);

/**
 * Preview style for edited JSDoc markdown on the reference pages, matching
 * Starlight's markdown until the regenerated page replaces the preview.
 */
export const jsdocMarkdownStyle: MarkdownStyle = {
  elements: {
    code: { dir: "auto" },
    pre: { class: "copy-preview-code" },
  },
  // `{@link X}` / `{@link X label}` render as the label or `X` in code.
  rewrite: [
    ["\\{@link\\s+[^}\\s|]+\\s*[|\\s]\\s*([^}]+)\\}", "$1"],
    ["\\{@link\\s+(?:import\\([^)]*\\)\\.)?([^}\\s]+)\\s*\\}", "`$1`"],
  ],
  css: `
    [data-copy-style="docs"] pre.copy-preview-code {
      margin: 1rem 0;
      padding: 0.9rem 1.1rem;
      overflow-x: auto;
      border: 1px solid var(--sl-color-gray-5, #444);
      border-radius: 6px;
      background: var(--sl-color-gray-6, #1a1a1a);
      font-size: var(--sl-text-code, 0.875rem);
      line-height: 1.6;
    }
    [data-copy-style="docs"] pre.copy-preview-code code {
      background: none;
      padding: 0;
      font-size: inherit;
    }
  `,
};

/** Resolves a copy id to its source file and parsed comment. */
const locate = async (id: string) => {
  const parsed = parseJsdocCopyId(id);
  const file = parsed && path.resolve(repoRoot, parsed.file);
  if (
    !parsed ||
    !file ||
    !file.startsWith(path.join(repoRoot, "packages") + path.sep) ||
    !/\.tsx?$/.test(file)
  ) {
    throw new CopyEditError(`Invalid JSDoc copy id: ${id}`);
  }
  const code = await fs.readFile(file, "utf8");
  if (!code.startsWith("/**", parsed.commentStart)) {
    throw new CopyEditError(
      "The JSDoc moved since this page was generated. Reload and try again.",
      409,
    );
  }
  const lines = docCommentLines(code, parsed.commentStart);
  return { parsed, file, code, lines, targets: docTargets(lines) };
};

const gone = () =>
  new CopyEditError(
    "This part of the JSDoc no longer exists. Reload and try again.",
    409,
  );

/** A fingerprint of a comment's editable structure (ids depend on it). */
const shape = (targets: ReturnType<typeof docTargets>) =>
  JSON.stringify([
    targets.regions.map((r) => [r.kind, r.editable]),
    targets.inline.map((b) => b.kind),
  ]);

/**
 * Saves copy edits made on generated API reference pages back into the JSDoc
 * the page was generated from, then regenerates the reference pages.
 *
 * Pages carry copy markup when the generator runs with
 * `API_REFERENCE_COPY_MARKERS=1` (see `dev:site`): prose regions are edited
 * as markdown, titles inline.
 */
export const jsdocCopyHandler = (): CopyEditHandler => {
  let running: Promise<void> | undefined;
  let queued: Promise<void> | undefined;

  const runGenerator = () =>
    new Promise<void>((resolve, reject) => {
      const child = spawn("bun", [generator], {
        cwd: repoRoot,
        env: { ...process.env, API_REFERENCE_COPY_MARKERS: "1" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`API reference generation failed:\n${stderr}`)),
      );
    });

  // One run at a time; edits made during a run share a single follow-up run.
  const regenerate = (): Promise<void> => {
    if (queued) return queued;
    if (!running) {
      running = runGenerator().finally(() => (running = undefined));
      return running;
    }
    queued = running
      .catch(() => {})
      .then(() => {
        queued = undefined;
        return regenerate();
      });
    return queued;
  };

  const save = async (
    file: string,
    display: string,
    before: ReturnType<typeof docTargets>,
    code: string,
    commentStart: number,
    context: Parameters<NonNullable<CopyEditHandler["edit"]>>[1],
  ) => {
    await fs.writeFile(file, code);
    // The page already shows the edit; keep the regenerated page's reload
    // from interrupting whatever the editor does next.
    const work = regenerate();
    work.catch((error: Error) => context.logger.error(error.message));
    context.suppressReloads(work);
    const after = docTargets(docCommentLines(code, commentStart));
    return {
      file: display,
      changed: true,
      reload: shape(after) !== shape(before),
    };
  };

  return {
    async edit({ id, before, after }, context) {
      const { parsed, file, code, targets } = await locate(id);
      const block =
        "block" in parsed ? targets.inline[parsed.block!] : undefined;
      if (!block) throw gone();
      const runs = markdownRuns(code, block.start, block.end, markdown);
      const next = applyRuns(code, runs, dialect, { before, after });
      if (next === code) return { file: parsed.file, changed: false };
      return save(
        file,
        parsed.file,
        targets,
        next,
        parsed.commentStart,
        context,
      );
    },

    async readSource(id) {
      const { parsed, lines, targets } = await locate(id);
      const region =
        "region" in parsed ? targets.regions[parsed.region!] : undefined;
      if (!region?.editable) throw gone();
      return regionSource(lines, region);
    },

    async writeSource({ id, source, base }, context) {
      const { parsed, file, code, lines, targets } = await locate(id);
      const region =
        "region" in parsed ? targets.regions[parsed.region!] : undefined;
      if (!region?.editable) throw gone();
      if (regionSource(lines, region) !== base) {
        throw new CopyEditError(
          "This JSDoc changed since you started editing. Copy your text, reload, and try again.",
          409,
        );
      }
      let next: string;
      try {
        next = replaceRegion(code, lines, region, source);
      } catch (error) {
        throw new CopyEditError((error as Error).message);
      }
      if (next === code) return { file: parsed.file, changed: false };
      return save(
        file,
        parsed.file,
        targets,
        next,
        parsed.commentStart,
        context,
      );
    },
  };
};
