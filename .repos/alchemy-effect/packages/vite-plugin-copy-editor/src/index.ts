import { promises as fs } from "node:fs";
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import {
  annotate,
  applyEdit,
  ATTR,
  inlineSource,
  strip,
  writeInline,
} from "./source.ts";
import { CopyEditError, type TextEdit } from "./text.ts";

export { CopyEditError, applyRuns, htmlDialect, normalize } from "./text.ts";
export type {
  Dialect,
  EscapeContext,
  Run,
  RunKind,
  TextEdit,
  TextToken,
} from "./text.ts";
export { markdownDialect, markdownRuns } from "./markdown.ts";
export type { Atomic, MarkdownOptions } from "./markdown.ts";
export {
  MARKDOWN_FILE_SCHEME,
  markdownBlocks,
  markdownFiles,
} from "./markdown-files.ts";
export type { MarkdownFilesOptions } from "./markdown-files.ts";

const CLIENT_ID = "virtual:copy-editor/client";
const CONFIG_ID = "virtual:copy-editor/config";
const RESOLVED_CONFIG_ID = `\0${CONFIG_ID}`;
const SAVE_ENDPOINT = "/__copy-editor/save";
const SOURCE_ENDPOINT = "/__copy-editor/source";
/** Sent once a handler's follow-up work settles, so previews can refresh. */
const REFRESH_EVENT = "copy-editor:refresh";
/** Time for watchers (e.g. a content layer) to pick up regenerated files. */
const REFRESH_DELAY_MS = 1500;
// Resolves to the TypeScript source under bun and the compiled file otherwise.
const CLIENT_FILE = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "./client.ts" : "./client.js",
    import.meta.url,
  ),
);

/** How long after a save to swallow the full-page reload it triggers. */
const RELOAD_SUPPRESS_MS = 1500;

export interface CopyEditContext {
  /** The Vite project root. */
  root: string;
  logger: ResolvedConfig["logger"];
  /**
   * Swallows full-page reloads until `work` settles (plus a short grace
   * period), for follow-up work such as regenerating derived files whose
   * content the page already shows.
   */
  suppressReloads(work: Promise<unknown>): void;
}

export interface SaveResult {
  /** Display path of the file that was written. */
  file: string;
  changed: boolean;
  /**
   * The edit changed the page's structure (e.g. added a section), so other
   * editable ids on the page are stale: reload once follow-up work settles.
   */
  reload?: boolean;
}

/**
 * Saves edits for ids of the form `<scheme>:<rest>`. Throw a
 * {@link CopyEditError} to reject an edit with a message for the browser.
 */
export interface CopyEditHandler {
  /** Saves an inline text edit to a `data-copy` element. */
  edit?(
    edit: TextEdit & { id: string },
    context: CopyEditContext,
  ): Promise<SaveResult>;
  /** Returns the markdown behind a `data-copy-format="markdown"` section. */
  readSource?(id: string, context: CopyEditContext): Promise<string>;
  /**
   * Replaces the markdown behind a section. `base` is the source the editor
   * started from; reject with a 409 {@link CopyEditError} if it's stale.
   */
  writeSource?(
    edit: { id: string; source: string; base: string },
    context: CopyEditContext,
  ): Promise<SaveResult>;
}

/** Elements a markdown preview can style, keyed like CSS selectors. */
export type MarkdownElement =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "a"
  | "strong"
  | "em"
  | "del"
  /** Inline code (not inside a code block). */
  | "code"
  /** Code blocks. */
  | "pre"
  | "ul"
  | "ol"
  | "li"
  | "blockquote"
  | "hr"
  | "img"
  | "table"
  | "th"
  | "td";

/**
 * How a markdown section renders its preview after an edit, until the page's
 * own renderer catches up. A section picks a style with
 * `data-copy-style="<name>"`.
 */
export interface MarkdownStyle {
  /** Attributes set on rendered elements; `class` values are appended. */
  elements?: Partial<Record<MarkdownElement, Record<string, string>>>;
  /** CSS added to the page in dev (scope it with `[data-copy-style="<name>"]`). */
  css?: string;
  /**
   * Regex rewrites applied to the markdown before previewing, for syntax the
   * page's renderer understands but plain markdown doesn't.
   */
  rewrite?: Array<[pattern: string, replacement: string]>;
}

export interface CopyEditorOptions {
  /**
   * Source files that may contain `data-copy` elements.
   * @default /\.(astro|html|jsx|tsx|vue|svelte)$/
   */
  include?: RegExp;
  /**
   * Handlers for copy that isn't a `data-copy` element in a template, keyed
   * by id scheme. Content rendered without Vite transforms (markdown, a CMS)
   * marks its element with a trailing `<!--copy:<scheme>:<rest>-->` comment,
   * and edits to it are saved by `handlers[<scheme>]`.
   */
  handlers?: Record<string, CopyEditHandler>;
  /** Named preview styles for markdown sections. */
  markdownStyles?: Record<string, MarkdownStyle>;
}

/**
 * Inline copy editing for any Vite app.
 *
 * Mark a hardcoded piece of copy with a bare attribute:
 *
 * ```html
 * <h1 data-copy>Reach for the better primitives.</h1>
 * ```
 *
 * - **Dev** (`vite serve`): every `data-copy` element is editable in the
 *   browser. Each edit is written back to the source file and flows through
 *   the normal HMR pipeline.
 * - **Build**: the attribute is stripped and no editor code ships.
 *
 * The element must contain only text and plain HTML tags (no expressions or
 * components). Register the plugin before framework plugins so it sees the
 * raw source. Copy from other sources (markdown, generated docs) plugs in
 * through {@link CopyEditorOptions.handlers}.
 */
export const copyEditor = (options: CopyEditorOptions = {}): Plugin => {
  const include = options.include ?? /\.(astro|html|jsx|tsx|vue|svelte)$/;
  let config: ResolvedConfig;
  let dev = false;

  const fileOf = (id: string) => id.split("?", 1)[0];
  const matches = (id: string) =>
    !id.startsWith("\0") &&
    !id.includes("/node_modules/") &&
    include.test(fileOf(id)) &&
    !/[?&](raw|url)\b/.test(id);
  const relative = (file: string) =>
    path.relative(config.root, file).split(path.sep).join("/");

  const rewrite = (code: string, file: string) =>
    dev ? annotate(code, relative(file)) : strip(code);

  return {
    name: "copy-editor",
    enforce: "pre",

    configResolved(resolved) {
      config = resolved;
      dev = resolved.command === "serve";
    },

    resolveId(id) {
      if (dev && id === CLIENT_ID) return CLIENT_FILE;
      if (dev && id === CONFIG_ID) return RESOLVED_CONFIG_ID;
    },

    load(id) {
      if (id === RESOLVED_CONFIG_ID) {
        return `export default ${JSON.stringify({ styles: options.markdownStyles ?? {} })};`;
      }
    },

    transform(code, id) {
      if (!code.includes(ATTR) || !matches(id)) return;
      return { code: rewrite(code, fileOf(id)), map: null };
    },

    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        if (!html.includes(ATTR)) return;
        return rewrite(html, ctx.filename);
      },
    },

    configureServer(server) {
      let suppressReloadUntil = 0;
      let pendingWork = 0;
      suppressFullReloads(
        server,
        () => pendingWork > 0 || Date.now() < suppressReloadUntil,
      );
      const context: CopyEditContext = {
        root: config.root,
        logger: config.logger,
        suppressReloads(work) {
          pendingWork++;
          work
            .catch(() => {})
            .finally(() => {
              pendingWork--;
              suppressReloadUntil = Math.max(
                suppressReloadUntil,
                Date.now() + REFRESH_DELAY_MS + RELOAD_SUPPRESS_MS,
              );
              // One refresh once everything saved so far has been processed.
              if (pendingWork > 0) return;
              setTimeout(() => {
                if (pendingWork === 0) {
                  server.ws.send({ type: "custom", event: REFRESH_EVENT });
                }
              }, REFRESH_DELAY_MS);
            });
        },
      };
      const handlerFor = (id: string) => {
        const scheme = /^([a-z][\w-]*):/.exec(id)?.[1];
        return scheme ? options.handlers?.[scheme] : undefined;
      };
      const respond = (res: ServerResponse, work: () => Promise<object>) =>
        work().then(
          (body) => {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(body));
          },
          (error: unknown) => {
            const status = error instanceof CopyEditError ? error.status : 500;
            const message =
              error instanceof Error ? error.message : String(error);
            config.logger.warn(`copy-editor: ${message}`, { timestamp: true });
            res.statusCode = status;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: message }));
          },
        );
      const logSave = (result: SaveResult) => {
        if (result.changed) {
          config.logger.info(`copy-editor: saved ${result.file}`, {
            timestamp: true,
          });
        }
        return result;
      };

      /** Resolves a template element id (`<file>#<n>`) to its file. */
      const templateElement = (id: string) => {
        const hash = id.lastIndexOf("#");
        const rel = id.slice(0, hash);
        const index = Number(id.slice(hash + 1));
        const file = path.resolve(config.root, rel);
        if (
          hash === -1 ||
          !Number.isInteger(index) ||
          !file.startsWith(path.resolve(config.root) + path.sep) ||
          !matches(file)
        ) {
          throw new CopyEditError(`Invalid copy id: ${id}`);
        }
        return { rel, index, file };
      };

      server.middlewares.use(SOURCE_ENDPOINT, (req, res) =>
        respond(res, async () => {
          if (req.method === "GET") {
            const id =
              new URL(req.url ?? "", "http://x").searchParams.get("id") ?? "";
            const handler = handlerFor(id);
            if (!handler) {
              const { index, file } = templateElement(id);
              const code = await fs.readFile(file, "utf8");
              return { source: inlineSource(code, index).markdown };
            }
            if (!handler.readSource) {
              throw new CopyEditError(`No markdown source for ${id}`);
            }
            return { source: await handler.readSource(id, context) };
          }
          if (req.method !== "POST")
            throw new CopyEditError("GET or POST only", 405);
          const edit = JSON.parse(await readBody(req)) as {
            id: string;
            source: string;
            base: string;
          };
          const handler = handlerFor(edit.id);
          if (!handler) {
            const { rel, index, file } = templateElement(edit.id);
            const code = await fs.readFile(file, "utf8");
            const next = writeInline(code, index, {
              markdown: edit.source,
              base: edit.base,
            });
            if (next === code) return { file: rel, changed: false };
            // The page shows the preview; skip the full reload it triggers.
            suppressReloadUntil = Date.now() + RELOAD_SUPPRESS_MS;
            await fs.writeFile(file, next);
            return logSave({ file: rel, changed: true });
          }
          if (!handler.writeSource) {
            throw new CopyEditError(`No markdown source for ${edit.id}`);
          }
          suppressReloadUntil = Date.now() + RELOAD_SUPPRESS_MS;
          return logSave(await handler.writeSource(edit, context));
        }),
      );

      const clientTag = `<script type="module" src="${config.base}@id/${CLIENT_ID}"></script>`;
      server.middlewares.use((_req, res, next) => {
        injectIntoHtml(res, clientTag);
        next();
      });

      server.middlewares.use(SAVE_ENDPOINT, async (req, res) => {
        const reply = (status: number, body: object) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (req.method !== "POST") return reply(405, { error: "POST only" });
        try {
          const { id, before, after } = JSON.parse(await readBody(req)) as {
            id: string;
            before: string[];
            after: string[];
          };
          const handler = handlerFor(id);
          if (handler) {
            if (!handler.edit)
              throw new CopyEditError(`${id} can't be edited inline`);
            suppressReloadUntil = Date.now() + RELOAD_SUPPRESS_MS;
            return reply(
              200,
              logSave(await handler.edit({ id, before, after }, context)),
            );
          }
          const hash = id.lastIndexOf("#");
          const rel = id.slice(0, hash);
          const index = Number(id.slice(hash + 1));
          const file = path.resolve(config.root, rel);
          if (
            hash === -1 ||
            !Number.isInteger(index) ||
            !file.startsWith(path.resolve(config.root) + path.sep) ||
            !matches(file)
          ) {
            throw new CopyEditError(`Invalid copy id: ${id}`);
          }
          const code = await fs.readFile(file, "utf8");
          const next = applyEdit(code, { index, before, after });
          if (next !== code) {
            // The DOM already shows the edit, so a full-page reload would only
            // cost the editor their place. Module-level HMR still applies.
            suppressReloadUntil = Date.now() + RELOAD_SUPPRESS_MS;
            await fs.writeFile(file, next);
            config.logger.info(`copy-editor: saved ${rel}`, {
              timestamp: true,
            });
          }
          reply(200, { file: rel, changed: next !== code });
        } catch (error) {
          const status = error instanceof CopyEditError ? error.status : 500;
          const message =
            error instanceof Error ? error.message : String(error);
          config.logger.warn(`copy-editor: ${message}`, { timestamp: true });
          reply(status, { error: message });
        }
      });
    },
  };
};

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

/**
 * Appends `tag` to any HTML response, whichever middleware produces it
 * (Vite's index.html handler or a framework's SSR handler).
 */
const injectIntoHtml = (res: ServerResponse, tag: string) => {
  let html: boolean | undefined;
  const isHtml = () =>
    (html ??= String(res.getHeader("content-type") ?? "").includes(
      "text/html",
    ));

  const writeHead = res.writeHead;
  res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
    const headers = args.find(
      (a): a is OutgoingHttpHeaders =>
        typeof a === "object" && a !== null && !Array.isArray(a),
    );
    if (headers) {
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower === "content-type")
          html = String(headers[key]).includes("text/html");
      }
      if (isHtml()) {
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === "content-length") delete headers[key];
        }
      }
    }
    if (isHtml()) res.removeHeader("content-length");
    return (writeHead as (...a: unknown[]) => ServerResponse).apply(this, args);
  } as typeof res.writeHead;

  const end = res.end;
  res.end = function (this: ServerResponse, ...args: unknown[]) {
    if (!isHtml())
      return (end as (...a: unknown[]) => ServerResponse).apply(this, args);
    if (!res.headersSent) res.removeHeader("content-length");
    const cb =
      typeof args[args.length - 1] === "function"
        ? (args.pop() as () => void)
        : undefined;
    const [chunk, encoding] = args as [unknown, BufferEncoding | undefined];
    if (chunk != null) res.write(chunk, encoding as BufferEncoding);
    res.write(tag);
    return (end as (...a: unknown[]) => ServerResponse).call(this, cb);
  } as typeof res.end;
};

/** Drops `full-reload` HMR messages while `active()` is true. */
const suppressFullReloads = (server: ViteDevServer, active: () => boolean) => {
  const channels = new Set([server.ws, server.environments.client.hot]);
  for (const channel of channels) {
    const send = channel.send.bind(channel) as (...args: unknown[]) => void;
    channel.send = ((...args: unknown[]) => {
      const payload = args[0] as { type?: string } | undefined;
      if (active() && payload?.type === "full-reload") return;
      send(...args);
    }) as typeof channel.send;
  }
};
