import {
  PLUGIN_MANIFEST_FILE,
  PLUGIN_SOURCE_PLUGINS_DIR,
  PluginManifest,
  PluginOperationError,
  PluginSourceId,
  type PluginAddSourceInput,
  type PluginCatalog,
  type PluginCatalogEntry,
  type PluginCreateInput,
  type PluginCreateViewUrlInput,
  type PluginDeleteInput,
  type PluginId,
  type PluginInvokeInput,
  type PluginInvokeResult,
  type PluginIssue,
  type PluginRemoveSourceInput,
  type PluginSetEnabledInput,
  type PluginSource,
  type PluginUpdateSourceInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

export const PLUGIN_ROUTE_PREFIX = "/api/plugins";

const DISABLED_MARKER = ".disabled";
const SIGNING_SECRET_NAME = "plugin-access-signing-key";
const TOKEN_TTL_MS = 60 * 60 * 1000;
/** Shared plugin source repositories are cloned under this directory. */
const SOURCES_DIR_NAME = ".sources";
/** Sidecar metadata (git remote) kept outside the clones so pulls never touch it. */
const SOURCE_METADATA_DIR_NAME = ".metadata";
/** Internal staging prefixes; dot-prefixed so discovery never sees them. */
const CLONING_PREFIX = ".cloning-";
const CREATING_PREFIX = ".creating-";
/** Only sweep temporaries old enough that no in-flight attempt can still own one. */
const STALE_TEMPORARY_MS = 60 * 60 * 1000;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_ID_LENGTH = 64;
/** Mirrors PluginSourceGitUrl in the contracts; re-checked before spawning git. */
const GIT_URL_PATTERN = /^(?:https:\/\/|ssh:\/\/|git@)[^\s]+$/;
const MAX_GIT_URL_LENGTH = 512;
/** A clone can legitimately take much longer than a plugin invoke (30s). */
const GIT_TIMEOUT = "120 seconds";
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
const GIT_DETAIL_LIMIT = 500;
const MAX_SOURCE_ID_ATTEMPTS = 50;
/** Non-interactive, no credential helpers, no system config, no hooks or templates. */
const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_CONFIG_NOSYSTEM: "1",
  GCM_INTERACTIVE: "never",
};
const GIT_HARDENING_ARGS = [
  "-c",
  "core.hooksPath=",
  "-c",
  "init.templateDir=",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.file.allow=never",
] as const;
const PLUGIN_ASSET_EXTENSIONS = new Set([
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".map",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".otf",
  ".ttf",
  ".woff",
  ".woff2",
]);

const PluginClaims = Schema.Struct({
  version: Schema.Literal(3),
  pluginId: Schema.String,
  /**
   * Plugin directory relative to `config.pluginsDir` (e.g. `my-plugin` or
   * `.sources/acme/plugins/my-plugin`). Signing the location keeps asset
   * serving O(1): the hot path never rebuilds the discovery index.
   */
  pluginRoot: Schema.String,
  baseRelativePath: Schema.String,
  expiresAt: Schema.Number,
});
const PluginClaimsJson = Schema.fromJsonString(PluginClaims);
const SourceMetadata = Schema.Struct({ gitUrl: Schema.String });
const SourceMetadataJson = Schema.fromJsonString(SourceMetadata);
const decodeSourceMetadata = Schema.decodeUnknownExit(SourceMetadataJson);
const encodeSourceMetadata = Schema.encodeSync(SourceMetadataJson);
const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
const decodePluginClaims = Schema.decodeUnknownOption(PluginClaimsJson);
const encodePluginClaims = Schema.encodeSync(PluginClaimsJson);
const decodeUnknownJson = Schema.decodeUnknownExit(UnknownJsonString);
const encodeUnknownJson = Schema.encodeSync(UnknownJsonString);
const decodeManifest = Schema.decodeUnknownExit(Schema.fromJsonString(PluginManifest));

type PluginOperation = PluginOperationError["operation"];

class PluginRegistryError extends Data.TaggedError("PluginRegistryError")<{
  readonly message: string;
}> {}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function operationError(operation: PluginOperation, error: unknown): PluginOperationError {
  return new PluginOperationError({ operation, message: describeError(error) });
}

function decodeClaims(encodedPayload: string): typeof PluginClaims.Type | null {
  try {
    return Option.getOrNull(decodePluginClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

function decodeRelativePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Signed claims carry a plugin root relative to `config.pluginsDir`. Reject
 * anything absolute or traversing before it is joined; realpath containment
 * still runs afterwards.
 */
function isContainedRelativeRoot(path: Path.Path, value: string): boolean {
  if (!value || value.length > 256 || value.includes("\0") || path.isAbsolute(value)) return false;
  const segments = value.split(/[\\/]/);
  if (segments.length > 8) return false;
  return segments.every(
    (segment) => segment !== "." && segment !== ".." && /^[A-Za-z0-9._-]+$/.test(segment),
  );
}

/** Control characters never belong in a remote URL handed to git. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const optionOnNotFound = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      typeof error === "object" &&
      error !== null &&
      "reason" in error &&
      typeof error.reason === "object" &&
      error.reason !== null &&
      "_tag" in error.reason &&
      error.reason._tag === "NotFound"
        ? Effect.succeed(Option.none<A>())
        : Effect.fail(error),
    ),
  );

/**
 * True when `directory` still resolves (through symlinks) to a strict descendant
 * of the already canonical `canonicalRoot`. Unreadable paths count as outside.
 */
const isInsideDirectory = Effect.fn("PluginRegistry.isInsideDirectory")(function* (
  canonicalRoot: string,
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonical = yield* fileSystem.realPath(directory).pipe(Effect.orElseSucceed(() => null));
  if (canonical === null) return false;
  const relative = path.relative(canonicalRoot, canonical);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
});

/**
 * A crash, a kill or an interrupt during the clone/create window leaves a
 * partial staging directory behind that `Effect.onError` never gets to remove.
 * They are dot-prefixed, so discovery would ignore them forever; sweep the
 * leftovers of earlier attempts before starting a new one.
 */
const sweepStaleTemporaries = Effect.fn("PluginRegistry.sweepStaleTemporaries")(function* (
  directory: string,
  prefix: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const canonicalRoot = yield* fileSystem
    .realPath(directory)
    .pipe(Effect.orElseSucceed(() => null));
  if (canonicalRoot === null) return;
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.forEach(
    names.filter((name) => name.startsWith(prefix)),
    (name) =>
      Effect.gen(function* () {
        const entry = path.join(directory, name);
        const info = yield* fileSystem.stat(entry).pipe(Effect.exit);
        if (Exit.isFailure(info) || info.value.type !== "Directory") return;
        // A concurrent attempt owns a freshly touched temporary; leave it alone.
        const mtime = Option.getOrNull(info.value.mtime);
        if (mtime !== null && now - mtime.getTime() < STALE_TEMPORARY_MS) return;
        // Never delete through a symlink that leaves the directory owning it.
        if (!(yield* isInsideDirectory(canonicalRoot, entry))) return;
        yield* fileSystem.remove(entry, { recursive: true, force: true }).pipe(Effect.ignore);
      }),
    { discard: true },
  );
});

const readPlugin = Effect.fn("PluginRegistry.readPlugin")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(directory, PLUGIN_MANIFEST_FILE);
  const manifestText = yield* fileSystem.readFileString(manifestPath);
  const decoded = decodeManifest(manifestText);
  if (Exit.isFailure(decoded)) {
    return yield* new PluginRegistryError({
      message: `Invalid ${PLUGIN_MANIFEST_FILE}: ${describeError(Cause.squash(decoded.cause))}`,
    });
  }
  const manifest = decoded.value;
  if (new Set(manifest.commands.map((command) => command.name)).size !== manifest.commands.length) {
    return yield* new PluginRegistryError({ message: "Plugin command names must be unique." });
  }
  if (path.basename(directory) !== manifest.id) {
    return yield* new PluginRegistryError({
      message: `Manifest id "${manifest.id}" must match directory name "${path.basename(directory)}".`,
    });
  }
  const enabled = !(yield* fileSystem.exists(path.join(directory, DISABLED_MARKER)));
  return { ...manifest, enabled } satisfies PluginCatalogEntry;
});

/** One discovered plugin: its id is independent from where it lives on disk. */
interface PluginRecord {
  readonly id: PluginId;
  /** Absolute plugin root; always nested somewhere under `config.pluginsDir`. */
  readonly directory: string;
  /** Set when the plugin came from a cloned source repository. */
  readonly sourceId?: PluginSourceId;
}

interface PluginDiscovery {
  readonly catalog: PluginCatalog;
  readonly records: ReadonlyMap<string, PluginRecord>;
}

/**
 * Discovery follows symlinks, but every later operation re-anchors the plugin
 * root with realpath containment, so a directory pointing out of the tree could
 * never be opened, toggled or deleted. Report it instead of listing it.
 */
const ESCAPED_DIRECTORY_MESSAGE =
  "This directory resolves outside the plugins directory (for example through a symlink) and is ignored.";

function describeRecordOrigin(record: PluginRecord): string {
  return record.sourceId === undefined ? "a local plugin directory" : `source "${record.sourceId}"`;
}

/** Recovers the remote for sources cloned outside `addSource` (no metadata file). */
function parseOriginUrl(gitConfigText: string): string | null {
  const section = /\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/.exec(gitConfigText);
  if (!section?.[1]) return null;
  const url = /^[ \t]*url[ \t]*=[ \t]*(.+)$/m.exec(section[1]);
  return url?.[1]?.trim() || null;
}

const sourceMetadataPath = (path: Path.Path, sourcesRoot: string, sourceId: string) =>
  path.join(sourcesRoot, SOURCE_METADATA_DIR_NAME, `${sourceId}.json`);

const readSourceGitUrl = Effect.fn("PluginRegistry.readSourceGitUrl")(function* (
  sourcesRoot: string,
  sourceId: string,
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const metadataText = yield* fileSystem
    .readFileString(sourceMetadataPath(path, sourcesRoot, sourceId))
    .pipe(Effect.orElseSucceed(() => null));
  if (metadataText !== null) {
    const decoded = decodeSourceMetadata(metadataText);
    if (Exit.isSuccess(decoded) && decoded.value.gitUrl) return decoded.value.gitUrl;
  }
  const gitConfigText = yield* fileSystem
    .readFileString(path.join(directory, ".git", "config"))
    .pipe(Effect.orElseSucceed(() => null));
  return gitConfigText === null ? null : parseOriginUrl(gitConfigText);
});

/**
 * Single filesystem pass that produces both the catalog and the id -> directory
 * index. Loose plugins live at `pluginsDir/<id>`, source plugins at
 * `pluginsDir/.sources/<sourceId>/plugins/<id>`.
 */
const discoverPlugins = Effect.fn("PluginRegistry.discoverPlugins")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const plugins: PluginCatalogEntry[] = [];
  const issues: PluginIssue[] = [];
  const sources: PluginSource[] = [];
  const records = new Map<string, PluginRecord>();

  // First registration wins: loose plugins are scanned before sources, and
  // sources are scanned in ascending id order.
  const register = (
    entry: PluginCatalogEntry,
    directory: string,
    label: string,
    sourceId?: PluginSourceId,
  ) => {
    const existing = records.get(entry.id);
    if (existing) {
      issues.push({
        directory: label,
        message: `Plugin id "${entry.id}" is already provided by ${describeRecordOrigin(existing)} at "${existing.directory}". This copy is ignored.`,
      });
      return false;
    }
    records.set(
      entry.id,
      sourceId === undefined ? { id: entry.id, directory } : { id: entry.id, directory, sourceId },
    );
    plugins.push(sourceId === undefined ? entry : { ...entry, sourceId });
    return true;
  };

  const canonicalPluginsDir = yield* fileSystem
    .realPath(config.pluginsDir)
    .pipe(Effect.orElseSucceed(() => config.pluginsDir));

  // Loose plugins: one level of pluginsDir. Dot-prefixed names (including
  // `.sources` and `.creating-*` temporaries) are skipped here. A deleted
  // plugins directory yields an empty catalog rather than failing the list.
  const directories = yield* fileSystem
    .readDirectory(config.pluginsDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  for (const name of directories.toSorted()) {
    if (name.startsWith(".")) continue;
    const directory = path.join(config.pluginsDir, name);
    const info = yield* fileSystem.stat(directory).pipe(Effect.exit);
    if (Exit.isFailure(info) || info.value.type !== "Directory") continue;
    if (!(yield* isInsideDirectory(canonicalPluginsDir, directory))) {
      issues.push({ directory: name, message: ESCAPED_DIRECTORY_MESSAGE });
      continue;
    }
    const result = yield* readPlugin(directory).pipe(Effect.exit);
    if (Exit.isSuccess(result)) {
      register(result.value, directory, name);
    } else {
      issues.push({ directory: name, message: describeError(Cause.squash(result.cause)) });
    }
  }

  const sourcesRoot = path.join(config.pluginsDir, SOURCES_DIR_NAME);
  const sourceNames = yield* fileSystem
    .readDirectory(sourcesRoot)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  for (const sourceName of sourceNames.toSorted()) {
    if (sourceName.startsWith(".")) continue;
    const directory = path.join(sourcesRoot, sourceName);
    const info = yield* fileSystem.stat(directory).pipe(Effect.exit);
    if (Exit.isFailure(info) || info.value.type !== "Directory") continue;
    const label = `${SOURCES_DIR_NAME}/${sourceName}`;
    if (!SLUG_PATTERN.test(sourceName) || sourceName.length > MAX_ID_LENGTH) {
      issues.push({
        directory: label,
        message: `Source directory name "${sourceName}" is not a valid source id.`,
      });
      continue;
    }
    const sourceId = PluginSourceId.make(sourceName);
    const sourceIssues: string[] = [];
    const gitUrl = yield* readSourceGitUrl(sourcesRoot, sourceName, directory);
    if (gitUrl === null) {
      sourceIssues.push("Could not determine the git remote for this source.");
    }

    const pluginIds: PluginId[] = [];
    const pluginsRoot = path.join(directory, PLUGIN_SOURCE_PLUGINS_DIR);
    const pluginNames = yield* fileSystem.readDirectory(pluginsRoot).pipe(Effect.exit);
    if (Exit.isFailure(pluginNames)) {
      sourceIssues.push(
        `No "${PLUGIN_SOURCE_PLUGINS_DIR}" directory in this source repository. Expected ${PLUGIN_SOURCE_PLUGINS_DIR}/<id>/${PLUGIN_MANIFEST_FILE}.`,
      );
    } else {
      for (const pluginName of pluginNames.value.toSorted()) {
        if (pluginName.startsWith(".")) continue;
        const pluginDirectory = path.join(pluginsRoot, pluginName);
        const pluginInfo = yield* fileSystem.stat(pluginDirectory).pipe(Effect.exit);
        if (Exit.isFailure(pluginInfo) || pluginInfo.value.type !== "Directory") continue;
        const pluginLabel = `${label}/${PLUGIN_SOURCE_PLUGINS_DIR}/${pluginName}`;
        if (!(yield* isInsideDirectory(canonicalPluginsDir, pluginDirectory))) {
          issues.push({ directory: pluginLabel, message: ESCAPED_DIRECTORY_MESSAGE });
          continue;
        }
        const result = yield* readPlugin(pluginDirectory).pipe(Effect.exit);
        if (Exit.isFailure(result)) {
          issues.push({
            directory: pluginLabel,
            message: describeError(Cause.squash(result.cause)),
          });
          continue;
        }
        if (register(result.value, pluginDirectory, pluginLabel, sourceId)) {
          pluginIds.push(result.value.id);
        }
      }
    }

    sources.push({
      id: sourceId,
      gitUrl: gitUrl ?? "",
      directory,
      pluginIds,
      ...(sourceIssues.length > 0 ? { issue: sourceIssues.join(" ") } : {}),
    });
  }

  plugins.sort((left, right) => left.name.localeCompare(right.name));
  return {
    catalog: {
      pluginsDirectory: config.pluginsDir,
      plugins,
      issues,
      sources,
    } satisfies PluginCatalog,
    records,
  } satisfies PluginDiscovery;
});

export const listPlugins = Effect.fn("PluginRegistry.listPlugins")(function* () {
  return (yield* discoverPlugins()).catalog;
});

/**
 * Resolves a plugin id to its (canonical) directory through the discovery
 * index, so callers never assume `pluginsDir/<id>`. Every resolved root is
 * verified to sit inside `config.pluginsDir`.
 */
const resolvePluginDirectory = Effect.fn("PluginRegistry.resolvePluginDirectory")(function* (
  pluginId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  if (!SLUG_PATTERN.test(pluginId) || pluginId.length > MAX_ID_LENGTH) {
    return yield* new PluginRegistryError({ message: `Invalid plugin id "${pluginId}".` });
  }
  const { records } = yield* discoverPlugins();
  const record = records.get(pluginId);
  if (!record) {
    return yield* new PluginRegistryError({ message: `Plugin "${pluginId}" was not found.` });
  }
  const [canonicalRoot, canonicalDirectory] = yield* Effect.all([
    fileSystem.realPath(config.pluginsDir),
    fileSystem.realPath(record.directory),
  ]);
  const relativeRoot = path.relative(canonicalRoot, canonicalDirectory);
  if (!relativeRoot || relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) {
    return yield* new PluginRegistryError({
      message: "Plugin resolves outside the plugins directory.",
    });
  }
  return { ...record, directory: canonicalDirectory, relativeRoot };
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const STARTER_FILES = (input: PluginCreateInput): Readonly<Record<string, string>> => ({
  [PLUGIN_MANIFEST_FILE]: `${JSON.stringify(
    {
      schemaVersion: 1,
      id: input.id,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      commands: [
        {
          name: "home",
          title: "Home",
          description: "Starter plugin page",
          entry: "dist/home.html",
        },
      ],
    },
    null,
    2,
  )}\n`,
  "package.json": `${JSON.stringify(
    {
      name: `t3-plugin-${input.id}`,
      private: true,
      type: "module",
      scripts: { dev: "vite", build: "vite build" },
      dependencies: {
        "@t3tools/plugin-sdk": "file:vendor/plugin-sdk",
        react: "^19.0.0",
        "react-dom": "^19.0.0",
      },
      devDependencies: {
        "@vitejs/plugin-react": "^5.0.0",
        "@types/react": "^19.0.0",
        "@types/react-dom": "^19.0.0",
        vite: "^7.0.0",
      },
    },
    null,
    2,
  )}\n`,
  "pnpm-workspace.yaml": `packages:\n  - "."\n\nallowBuilds:\n  esbuild: true\n`,
  "vite.config.ts": `import react from "@vitejs/plugin-react";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({\n  base: "./",\n  plugins: [react()],\n  build: { rollupOptions: { input: { home: "home.html" } } },\n});\n`,
  "home.html": `<!doctype html>\n<html><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${escapeHtml(input.name)}</title></head><body><div id="root"></div><script type="module" src="/src/home.tsx"></script></body></html>\n`,
  "src/home.tsx": `import { Detail, PluginRoot, showToast } from "@t3tools/plugin-sdk";\nimport { createRoot } from "react-dom/client";\n\nfunction Home() {\n  return (\n    <PluginRoot title={${JSON.stringify(input.name)}}>\n      <Detail\n        title="Your plugin is running"\n        markdown="Edit src/home.tsx, run pnpm build, then reload from T3 Code."\n        actions={[{ title: "Test toast", onAction: () => showToast({ title: ${JSON.stringify(`Hello from ${input.name}`)} }) }]}\n      />\n    </PluginRoot>\n  );\n}\n\ncreateRoot(document.getElementById("root")!).render(<Home />);\n`,
  "vendor/plugin-sdk/package.json": `${JSON.stringify(
    {
      name: "@t3tools/plugin-sdk",
      version: "0.0.1",
      type: "module",
      exports: { ".": "./index.tsx" },
      peerDependencies: { react: "^19.0.0" },
    },
    null,
    2,
  )}\n`,
  "vendor/plugin-sdk/index.tsx": `import type { CSSProperties, ReactNode } from "react";\n\ntype Action = { title: string; onAction: () => void };\ntype PendingInvocation = { resolve: (value: unknown) => void; reject: (error: Error) => void };\nconst pending = new Map<string, PendingInvocation>();\nconst invocationSession = crypto.randomUUID();\nlet requestSequence = 0;\nconst nonce = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("t3-nonce") ?? "";\nconst send = (message: object) => window.parent.postMessage({ source: "t3-plugin", nonce, ...message }, "*");\nwindow.addEventListener("message", (event) => {\n  if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;\n  const message = event.data as Record<string, unknown>;\n  if (message.source !== "t3-host" || message.type !== "invoke-result" || typeof message.requestId !== "string") return;\n  const invocation = pending.get(message.requestId);\n  if (!invocation) return;\n  pending.delete(message.requestId);\n  if (message.ok === true) invocation.resolve(message.value);\n  else invocation.reject(new Error(typeof message.error === "string" ? message.error : "Plugin action failed."));\n});\nexport const showToast = (input: { title: string; message?: string }) => send({ type: "show-toast", ...input });\nexport const openExternal = (url: string) => send({ type: "open-external", url });\nexport function invoke<T = unknown>(action: string, input: unknown = null): Promise<T> {\n  const requestId = invocationSession + "-" + ++requestSequence;\n  return new Promise<T>((resolve, reject) => {\n    pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });\n    send({ type: "invoke", requestId, action, input });\n  });\n}\nconst shell: CSSProperties = { minHeight: "100vh", boxSizing: "border-box", padding: 32, background: "#111", color: "#f5f5f5", font: "14px ui-sans-serif, system-ui" };\nexport function PluginRoot(props: { title: string; children: ReactNode }) { return <main style={shell}><header style={{ opacity: .6, marginBottom: 24 }}>{props.title}</header>{props.children}</main>; }\nexport function Detail(props: { title: string; markdown: string; actions?: readonly Action[] }) { return <section><h1 style={{ fontSize: 24, margin: "0 0 12px" }}>{props.title}</h1><p style={{ color: "#aaa", lineHeight: 1.6 }}>{props.markdown}</p><div style={{ display: "flex", gap: 8, marginTop: 24 }}>{props.actions?.map((action) => <button key={action.title} onClick={action.onAction} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #444", background: "#222", color: "inherit", cursor: "pointer" }}>{action.title}</button>)}</div></section>; }\n`,
  "dist/home.html": `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.name)}</title><link rel="stylesheet" href="plugin.css"></head><body><main><div class="eyebrow">${escapeHtml(input.name)}</div><h1>Your plugin is running</h1><p>Edit <code>src/home.tsx</code>, run <code>pnpm install && pnpm build</code>, then reload this page.</p><button id="toast">Test host API</button></main><script src="plugin.js"></script></body></html>`,
  "dist/plugin.css": `:root{color-scheme:dark;font:14px ui-sans-serif,system-ui;background:#111;color:#f5f5f5}body{margin:0}main{padding:32px}.eyebrow{color:#888;margin-bottom:24px}h1{font-size:24px}p{color:#aaa;line-height:1.6}code{color:#ddd}button{margin-top:16px;padding:8px 12px;border:1px solid #444;border-radius:8px;background:#222;color:inherit;cursor:pointer}`,
  "dist/plugin.js": `const nonce=new URLSearchParams(window.location.hash.replace(/^#/,"")).get("t3-nonce")??"";document.querySelector("#toast")?.addEventListener("click",()=>window.parent.postMessage({source:"t3-plugin",nonce,type:"show-toast",title:${JSON.stringify(`Hello from ${input.name}`)}},"*"));`,
});

export const createPlugin = (input: PluginCreateInput) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const config = yield* ServerConfig.ServerConfig;
    const target = path.join(config.pluginsDir, input.id);
    if (yield* fileSystem.exists(target)) {
      return yield* new PluginRegistryError({ message: `Plugin "${input.id}" already exists.` });
    }
    yield* sweepStaleTemporaries(config.pluginsDir, CREATING_PREFIX);
    const suffix = yield* crypto.randomUUIDv4;
    const temporary = path.join(config.pluginsDir, `${CREATING_PREFIX}${input.id}-${suffix}`);
    yield* fileSystem.makeDirectory(temporary, { recursive: true });
    yield* Effect.forEach(
      Object.entries(STARTER_FILES(input)),
      ([relativePath, contents]) => {
        const destination = path.join(temporary, relativePath);
        return fileSystem
          .makeDirectory(path.dirname(destination), { recursive: true })
          .pipe(Effect.andThen(fileSystem.writeFileString(destination, contents)));
      },
      { concurrency: "unbounded", discard: true },
    ).pipe(
      Effect.andThen(fileSystem.rename(temporary, target)),
      Effect.onError(() =>
        fileSystem.remove(temporary, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    return yield* listPlugins();
  }).pipe(Effect.mapError((error) => operationError("create", error)));

export const setPluginEnabled = (input: PluginSetEnabledInput) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const record = yield* resolvePluginDirectory(input.pluginId);
    const marker = path.join(record.directory, DISABLED_MARKER);
    if (input.enabled) {
      yield* fileSystem.remove(marker, { force: true });
    } else {
      yield* fileSystem.writeFileString(marker, "disabled\n");
    }
    return yield* listPlugins();
  }).pipe(Effect.mapError((error) => operationError("set-enabled", error)));

export const deletePlugin = (input: PluginDeleteInput) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const record = yield* resolvePluginDirectory(input.pluginId);
    if (record.sourceId !== undefined) {
      return yield* new PluginRegistryError({
        message: `Plugin "${input.pluginId}" is provided by source "${record.sourceId}" and cannot be deleted on its own. Remove the source instead; the next source update would restore this directory.`,
      });
    }
    yield* fileSystem.remove(record.directory, { recursive: true });
    return yield* listPlugins();
  }).pipe(Effect.mapError((error) => operationError("delete", error)));

/**
 * Folds only the differences that are always the same repository: a trailing
 * slash and a trailing `.git`. Anything more aggressive risks treating two
 * distinct remotes as one.
 */
function normalizeGitUrl(gitUrl: string): string {
  return gitUrl
    .trim()
    .replace(/[/\\]+$/, "")
    .replace(/\.git$/i, "");
}

/** `<owner>/<repo>.git` -> `repo`; returns null when nothing usable is left. */
function deriveSourceSlug(gitUrl: string): string | null {
  const withoutTrailingSlashes = gitUrl.replace(/[/\\]+$/, "");
  const lastSegment = withoutTrailingSlashes.split(/[/\\:]/).pop() ?? "";
  const slug = lastSegment
    .replace(/\.git$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 && slug.length <= MAX_ID_LENGTH && SLUG_PATTERN.test(slug) ? slug : null;
}

const runGit = Effect.fn("PluginRegistry.runGit")(function* (args: ReadonlyArray<string>) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  return yield* processRunner.run({
    command: "git",
    args: [...GIT_HARDENING_ARGS, ...args],
    env: GIT_ENV,
    timeout: GIT_TIMEOUT,
    maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    outputMode: "truncate",
  });
});

function gitFailure(action: string, result: ProcessRunner.ProcessRunOutput): PluginRegistryError {
  const detail = result.stderr.trim().slice(0, GIT_DETAIL_LIMIT);
  return new PluginRegistryError({
    message: detail
      ? `git ${action} failed (exit ${result.code ?? "unknown"}): ${detail}`
      : `git ${action} failed (exit ${result.code ?? "unknown"}).`,
  });
}

const nextAvailableSourceId = Effect.fn("PluginRegistry.nextAvailableSourceId")(function* (
  sourcesRoot: string,
  slug: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (let attempt = 1; attempt <= MAX_SOURCE_ID_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? slug : `${slug}-${attempt}`;
    if (candidate.length > MAX_ID_LENGTH) break;
    if (!(yield* fileSystem.exists(path.join(sourcesRoot, candidate)))) return candidate;
  }
  return yield* new PluginRegistryError({
    message: `Could not allocate a source id for "${slug}".`,
  });
});

/** Resolves `.sources/<sourceId>` with realpath containment under the sources root. */
const resolveSourceDirectory = Effect.fn("PluginRegistry.resolveSourceDirectory")(function* (
  sourceId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  if (!SLUG_PATTERN.test(sourceId) || sourceId.length > MAX_ID_LENGTH) {
    return yield* new PluginRegistryError({ message: `Invalid plugin source id "${sourceId}".` });
  }
  const sourcesRoot = path.join(config.pluginsDir, SOURCES_DIR_NAME);
  const directory = path.join(sourcesRoot, sourceId);
  if (!(yield* fileSystem.exists(directory))) {
    return yield* new PluginRegistryError({
      message: `Plugin source "${sourceId}" was not found.`,
    });
  }
  const [canonicalRoot, canonicalDirectory] = yield* Effect.all([
    fileSystem.realPath(sourcesRoot),
    fileSystem.realPath(directory),
  ]);
  const relative = path.relative(canonicalRoot, canonicalDirectory);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).length !== 1
  ) {
    return yield* new PluginRegistryError({
      message: "Plugin source resolves outside the plugin sources directory.",
    });
  }
  return { sourcesRoot, directory: canonicalDirectory };
});

export const addSource = (input: PluginAddSourceInput) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const config = yield* ServerConfig.ServerConfig;
    const gitUrl = input.gitUrl.trim();
    // Defensive re-validation: the contract schema already restricts this, but
    // the registry never hands an unchecked string to git.
    if (
      gitUrl.length > MAX_GIT_URL_LENGTH ||
      !GIT_URL_PATTERN.test(gitUrl) ||
      hasControlCharacter(gitUrl)
    ) {
      return yield* new PluginRegistryError({
        message: `Unsupported git URL "${gitUrl}". Use an https://, ssh:// or git@ remote.`,
      });
    }
    const slug = deriveSourceSlug(gitUrl);
    if (!slug) {
      return yield* new PluginRegistryError({
        message: `Could not derive a plugin source id from "${gitUrl}".`,
      });
    }
    const sourcesRoot = path.join(config.pluginsDir, SOURCES_DIR_NAME);
    yield* sweepStaleTemporaries(sourcesRoot, CLONING_PREFIX);
    // Cloning the same remote twice only ever produces a shadowed duplicate:
    // plugin registration is first-wins, so the second clone provides nothing.
    const normalized = normalizeGitUrl(gitUrl);
    const installed = (yield* discoverPlugins()).catalog.sources.find(
      (source) => source.gitUrl !== "" && normalizeGitUrl(source.gitUrl) === normalized,
    );
    if (installed) {
      return yield* new PluginRegistryError({
        message: `This repository is already installed as source "${installed.id}". Use Update to pull new commits.`,
      });
    }
    yield* fileSystem.makeDirectory(sourcesRoot, { recursive: true });
    const sourceId = yield* nextAvailableSourceId(sourcesRoot, slug);
    const target = path.join(sourcesRoot, sourceId);
    const suffix = yield* crypto.randomUUIDv4;
    const temporary = path.join(sourcesRoot, `${CLONING_PREFIX}${sourceId}-${suffix}`);
    // Clone into a temporary directory first so a failed clone never leaves a
    // partially populated source behind (same pattern as createPlugin).
    yield* runGit([
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      "--",
      gitUrl,
      temporary,
    ]).pipe(
      Effect.flatMap((result) =>
        result.code === 0 ? Effect.void : Effect.fail(gitFailure("clone", result)),
      ),
      Effect.andThen(fileSystem.rename(temporary, target)),
      Effect.onError(() =>
        fileSystem.remove(temporary, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    yield* fileSystem
      .makeDirectory(path.join(sourcesRoot, SOURCE_METADATA_DIR_NAME), { recursive: true })
      .pipe(
        Effect.andThen(
          fileSystem.writeFileString(
            sourceMetadataPath(path, sourcesRoot, sourceId),
            `${encodeSourceMetadata({ gitUrl })}\n`,
          ),
        ),
        Effect.ignore,
      );
    return yield* listPlugins();
  }).pipe(
    Effect.provide(ProcessRunner.layer),
    Effect.mapError((error) => operationError("add-source", error)),
  );

export const updateSource = (input: PluginUpdateSourceInput) =>
  Effect.gen(function* () {
    const source = yield* resolveSourceDirectory(input.sourceId);
    yield* runGit(["-C", source.directory, "pull", "--ff-only"]).pipe(
      Effect.flatMap((result) =>
        result.code === 0 ? Effect.void : Effect.fail(gitFailure("pull", result)),
      ),
    );
    return yield* listPlugins();
  }).pipe(
    Effect.provide(ProcessRunner.layer),
    Effect.mapError((error) => operationError("update-source", error)),
  );

export const removeSource = (input: PluginRemoveSourceInput) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = yield* resolveSourceDirectory(input.sourceId);
    yield* fileSystem.remove(source.directory, { recursive: true });
    yield* fileSystem
      .remove(sourceMetadataPath(path, source.sourcesRoot, input.sourceId), { force: true })
      .pipe(Effect.ignore);
    return yield* listPlugins();
  }).pipe(Effect.mapError((error) => operationError("remove-source", error)));

export const issuePluginViewUrl = (input: PluginCreateViewUrlInput) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const record = yield* resolvePluginDirectory(input.pluginId);
    const plugin = yield* readPlugin(record.directory);
    if (!plugin.enabled) return yield* new PluginRegistryError({ message: "Plugin is disabled." });
    const command = plugin.commands.find((candidate) => candidate.name === input.commandName);
    if (!command) {
      return yield* new PluginRegistryError({ message: "Plugin command was not found." });
    }
    const entry = path.join(record.directory, command.entry);
    const info = yield* optionOnNotFound(fileSystem.stat(entry));
    if (Option.isNone(info) || info.value.type !== "File") {
      return yield* new PluginRegistryError({
        message: `Built entry "${command.entry}" was not found.`,
      });
    }
    const expiresAt = (yield* Clock.currentTimeMillis) + TOKEN_TTL_MS;
    const baseRelativePath = path.dirname(command.entry);
    const encodedPayload = base64UrlEncode(
      encodePluginClaims({
        version: 3,
        pluginId: input.pluginId,
        pluginRoot: record.relativeRoot,
        baseRelativePath,
        expiresAt,
      }),
    );
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
    const token = `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;
    const encodedEntry = encodeURIComponent(path.basename(command.entry));
    return { relativeUrl: `${PLUGIN_ROUTE_PREFIX}/${token}/${encodedEntry}`, expiresAt };
  }).pipe(Effect.mapError((error) => operationError("create-view-url", error)));

const invokePluginProgram = Effect.fn("PluginRegistry.invokePlugin")(function* (
  input: PluginInvokeInput,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const record = yield* resolvePluginDirectory(input.pluginId);
  const pluginRoot = record.directory;
  const plugin = yield* readPlugin(pluginRoot);
  if (!plugin.enabled) return yield* new PluginRegistryError({ message: "Plugin is disabled." });
  if (!plugin.backend) {
    return yield* new PluginRegistryError({ message: "Plugin does not declare a backend." });
  }

  const candidate = path.join(pluginRoot, plugin.backend);
  const [canonicalRoot, canonicalBackend] = yield* Effect.all([
    optionOnNotFound(fileSystem.realPath(pluginRoot)),
    optionOnNotFound(fileSystem.realPath(candidate)),
  ]);
  if (Option.isNone(canonicalRoot) || Option.isNone(canonicalBackend)) {
    return yield* new PluginRegistryError({
      message: `Backend "${plugin.backend}" was not found.`,
    });
  }
  const relative = path.relative(canonicalRoot.value, canonicalBackend.value);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return yield* new PluginRegistryError({
      message: "Plugin backend resolves outside its package.",
    });
  }
  const info = yield* fileSystem.stat(canonicalBackend.value);
  if (info.type !== "File") {
    return yield* new PluginRegistryError({ message: "Plugin backend is not a file." });
  }

  const decodedInput = decodeUnknownJson(input.inputJson);
  if (Exit.isFailure(decodedInput)) {
    return yield* new PluginRegistryError({ message: "Plugin action input is not valid JSON." });
  }
  const stdin = encodeUnknownJson({ action: input.action, input: decodedInput.value });

  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner.run({
    command: process.execPath,
    args: [canonicalBackend.value],
    cwd: canonicalRoot.value,
    stdin,
    timeout: "30 seconds",
    maxOutputBytes: 4 * 1024 * 1024,
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim().slice(0, 1_000);
    return yield* new PluginRegistryError({
      message: detail ? `Plugin backend failed: ${detail}` : "Plugin backend failed.",
    });
  }

  const output = decodeUnknownJson(result.stdout);
  if (Exit.isFailure(output)) {
    return yield* new PluginRegistryError({ message: "Plugin backend returned invalid JSON." });
  }
  const outputJson = encodeUnknownJson(output.value);
  return { outputJson } satisfies PluginInvokeResult;
});

export const invokePlugin = (input: PluginInvokeInput) =>
  invokePluginProgram(input).pipe(
    Effect.provide(ProcessRunner.layer),
    Effect.mapError((error) => operationError("invoke", error)),
  );

export const resolvePluginAsset = Effect.fn("PluginRegistry.resolvePluginAsset")(function* (
  token: string,
  relativePath: string,
) {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingSecret = yield* secretStore
    .getOrCreateRandom(SIGNING_SECRET_NAME, 32)
    .pipe(Effect.orElseSucceed(() => null));
  if (!signingSecret) return null;
  if (!timingSafeEqualBase64Url(signature, signPayload(encodedPayload, signingSecret))) return null;
  const claims = decodeClaims(encodedPayload);
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
  if (!SLUG_PATTERN.test(claims.pluginId)) return null;
  const decodedPath = decodeRelativePath(relativePath);
  if (decodedPath === null) return null;
  const path = yield* Path.Path;
  if (!isContainedRelativeRoot(path, claims.pluginRoot)) return null;
  const segments = decodedPath.split(/[\\/]/);
  if (
    !decodedPath ||
    decodedPath.includes("\0") ||
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."),
    ) ||
    !PLUGIN_ASSET_EXTENSIONS.has(path.extname(decodedPath).toLowerCase())
  ) {
    return null;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const pluginRoot = path.join(config.pluginsDir, claims.pluginRoot);
  const disabled = yield* fileSystem
    .exists(path.join(pluginRoot, DISABLED_MARKER))
    .pipe(Effect.orElseSucceed(() => true));
  if (disabled) return null;
  const joinedRelativePath =
    claims.baseRelativePath === "." ? decodedPath : path.join(claims.baseRelativePath, decodedPath);
  const candidate = path.join(pluginRoot, joinedRelativePath);
  const [canonicalPluginsDir, canonicalRoot, canonicalFile] = yield* Effect.all([
    optionOnNotFound(fileSystem.realPath(config.pluginsDir)),
    optionOnNotFound(fileSystem.realPath(pluginRoot)),
    optionOnNotFound(fileSystem.realPath(candidate)),
  ]).pipe(
    Effect.orElseSucceed(
      () => [Option.none<string>(), Option.none<string>(), Option.none<string>()] as const,
    ),
  );
  if (
    Option.isNone(canonicalPluginsDir) ||
    Option.isNone(canonicalRoot) ||
    Option.isNone(canonicalFile)
  ) {
    return null;
  }
  // A plugin directory can itself be a symlink (git repositories may commit one),
  // so re-anchor the canonical root inside the plugins tree before trusting it as
  // the containment base for the requested file.
  const relativeRoot = path.relative(canonicalPluginsDir.value, canonicalRoot.value);
  if (!relativeRoot || relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) return null;
  const relative = path.relative(canonicalRoot.value, canonicalFile.value);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const info = yield* optionOnNotFound(fileSystem.stat(canonicalFile.value)).pipe(
    Effect.orElseSucceed(() => Option.none()),
  );
  return Option.isSome(info) && info.value.type === "File" ? canonicalFile.value : null;
});

export const listPluginsRpc = listPlugins().pipe(
  Effect.mapError((error) => operationError("list", error)),
);
