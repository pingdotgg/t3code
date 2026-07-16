import {
  HOST_API_VERSION,
  PluginCapability,
  PluginId,
  PluginManagementError,
  PluginManifest,
  compareSemver,
  hostApiSatisfies,
  isPrereleaseVersion,
  type MarketplaceVersion,
  type PluginId as PluginIdType,
  type PluginInfo,
  type PluginInstallStaged,
  type PluginLockfilePlugin,
} from "@t3tools/contracts/plugin";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClientResponse } from "effect/unstable/http";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { PluginHttpClientTransportService } from "./capabilities/HttpClientCapability.ts";
import { guardedOutboundHttpGet } from "./guardedOutboundHttpGet.ts";
import { OutboundUrlLookup } from "./OutboundUrlValidator.ts";
import { PluginCatalog } from "./PluginCatalog.ts";
import { PluginHost } from "./PluginHost.ts";
import { pluginSqlPrefix } from "./PluginMigrator.ts";
import { PluginLockfileStore } from "./PluginLockfileStore.ts";
import { PluginMarketplace } from "./PluginMarketplace.ts";
import { pluginManifestPath, pluginVersionDir } from "./PluginPaths.ts";
import { readHttpResponseBytesCapped } from "./readHttpResponseBytesCapped.ts";

const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const EXTRACT_TOTAL_MAX_BYTES = 128 * 1024 * 1024;
const EXTRACT_FILE_MAX_BYTES = 16 * 1024 * 1024;
const DECOMPRESSION_RATIO_MAX = 100;
const STAGE_TOKEN_TTL_MS = 15 * 60 * 1000;
const PRESERVE_DATA_MARKER = ".preserve-data-on-remove";

// Streaming gunzip with a HARD output cap: a bomb that expands past the cap is
// aborted mid-inflate, so peak memory stays ~cap + one chunk instead of the
// full (multi-GB) decompressed size. A one-shot gunzip would allocate the
// whole output before any size check could run.
const gunzipCapped = (bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const stream = NodeZlib.createGunzip();
    const chunks: Array<Buffer> = [];
    let total = 0;
    stream.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        stream.destroy();
        reject(
          managementError("extract-failed", "Plugin archive expands beyond the size limit.", {
            limit: maxBytes,
          }),
        );
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    stream.on("error", (cause) => reject(cause));
    stream.end(Buffer.from(bytes));
  });
const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));
const isPluginManagementError = Schema.is(PluginManagementError);

export const PLUGIN_CAPABILITY_DESCRIPTIONS = {
  agents: "Run AI agents",
  vcs: "Run git in your project and in worktrees this plugin creates \u2014 including commit, merge, push, branch switching, and deleting files, worktrees, and checkpoints. This changes and can discard work in your repositories, not just read them.",
  terminals:
    "Run commands in a real terminal on this machine with the host process's privileges, in any directory it can reach \u2014 not confined to your project. This is effectively a local shell; grant it only to plugins you trust to run programs on your computer.",
  database:
    "Read and write the app's shared database directly \u2014 including the app's own core tables and your workspace data, not only tables this plugin created. Grant it only to plugins you trust with everything the app stores.",
  "projections.read":
    "Read the full text and attachments of every message in every thread across all projects, plus turn and thread activity \u2014 not only this plugin's own threads. Like the events capability, this exposes the contents of your conversations; grant it only to plugins you trust with them.",
  "environments.read": "Read environment metadata",
  secrets: "Store plugin secrets",
  http: "Serve plugin HTTP routes",
  filesystem: "Read and write files in your project workspace and in worktrees this plugin creates",
  httpClient: "Make requests to public external HTTPS services",
  sourceControl: "Use source control integrations",
  textGeneration: "Request text generation",
  tools:
    "Add tools the AI agent can call in your threads. Installing this capability is a blanket grant: the agent may invoke every tool this plugin registers, and those tools may act through the plugin's other granted capabilities.",
  settings:
    "Read its own settings, which you configure on the plugin's settings page. This plugin cannot read any other plugin's settings.",
  // Say what is ACTUALLY on the stream. The first version of this copy described
  // "projects and threads being created, renamed, and deleted, and turns running",
  // which reads as metadata — but `thread.message-sent` carries `text`, the full body
  // of the message, and its attachments. Someone reading the metadata version would
  // never guess they were granting access to the content of every conversation.
  // Consent copy that misleads is worse than no copy at all.
  // Say what this actually grants: the plugin WRITES INTO the agent's instructions on
  // every turn. That is influence over what the agent does — a bigger grant than
  // reading events, and one a user cannot see the effects of directly. Ordering does
  // not protect the host's own rules: contributed text can simply say "ignore any
  // later instruction about X". The capability and this sentence are the control.
  // Says what it CANNOT do as plainly as what it can. A user reading "can block what
  // the agent does" would reasonably fear the opposite too — a plugin waving things
  // through — so the copy rules that out explicitly, because the code does.
  providers:
    "Add a new AI provider you can configure and chat with. Anything you send to a thread using that provider goes wherever the plugin sends it \u2014 the app cannot see or vouch for where that is. Grant this only to plugins you trust with the contents of those conversations. (staged: provider plugins are not yet selectable for chat)",
  policy:
    "See what the agent asks permission for \u2014 commands it wants to run, files it wants to read or change \u2014 and block them. It can only block: it can never approve something on your behalf, so you will still be asked about anything it does not block. A broken plugin here can stop the agent working; it cannot let it do more.",
  context:
    "Add its own instructions to the AI agent's turns (currently applied on Codex turns). This is not a read: it changes how the agent behaves, and it can work against the app's own instructions. Grant it only to plugins you trust to direct your agent.",
  events:
    "Read everything that happens in this workspace as it happens, including the full text of every message you and the agent send, their attachments, and the activity of every turn \u2014 plus projects and threads being created, renamed, and deleted. This is read-only, but it is very broad: the plugin sees this across every project, not only the one you are working in. Grant it only to plugins you trust with the contents of your conversations.",
} satisfies Record<PluginCapability, string>;

const managementError = (code: PluginManagementError["code"], message: string, data?: unknown) =>
  new PluginManagementError({
    code,
    message,
    ...(data === undefined ? {} : { data }),
  });

export class PluginInstaller extends Context.Service<
  PluginInstaller,
  {
    readonly beginInstall: (input: {
      readonly sourceId: string;
      readonly pluginId: PluginIdType;
      readonly version: string;
    }) => Effect.Effect<PluginInstallStaged, PluginManagementError>;
    readonly confirmInstall: (
      stageToken: string,
    ) => Effect.Effect<{ readonly plugin: PluginInfo }, PluginManagementError>;
    readonly abortInstall: (stageToken: string) => Effect.Effect<void, PluginManagementError>;
    readonly setEnabled: (input: {
      readonly pluginId: PluginIdType;
      readonly enabled: boolean;
    }) => Effect.Effect<void, PluginManagementError>;
    readonly uninstall: (input: {
      readonly pluginId: PluginIdType;
      readonly removeData: boolean;
    }) => Effect.Effect<void, PluginManagementError>;
    readonly beginUpgrade: (input: {
      readonly pluginId: PluginIdType;
      readonly version: string;
    }) => Effect.Effect<PluginInstallStaged, PluginManagementError>;
    readonly confirmUpgrade: (
      stageToken: string,
    ) => Effect.Effect<{ readonly plugin: PluginInfo }, PluginManagementError>;
    readonly checkUpdates: Effect.Effect<
      {
        readonly updates: ReadonlyArray<{
          readonly pluginId: PluginIdType;
          readonly currentVersion: string;
          readonly latestVersion: string;
        }>;
      },
      PluginManagementError
    >;
  }
>()("t3/plugins/PluginInstaller") {}

interface StageRecord {
  readonly operation: "install" | "upgrade";
  readonly stageToken: string;
  readonly sourceId: string;
  readonly pluginId: PluginIdType;
  readonly version: string;
  readonly sha256: string;
  readonly stagingDir: string;
  readonly expiresAtMs: number;
  readonly manifest: PluginManifest;
}

const sha256Hex = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const isGzip = (bytes: Uint8Array) => bytes[0] === 0x1f && bytes[1] === 0x8b;

const isZeroBlock = (block: Uint8Array) => block.every((byte) => byte === 0);

const cString = (bytes: Uint8Array) => {
  const end = bytes.indexOf(0);
  const slice = end === -1 ? bytes : bytes.slice(0, end);
  return new TextDecoder().decode(slice).trim();
};

const octal = (bytes: Uint8Array) => {
  const raw = cString(bytes).split("\u0000").join("").trim();
  return raw.length === 0 ? 0 : Number.parseInt(raw, 8);
};

const isAllowedArchivePath = (entryPath: string) =>
  entryPath === "manifest.json" ||
  entryPath === "server" ||
  entryPath.startsWith("server/") ||
  entryPath === "web" ||
  entryPath.startsWith("web/") ||
  entryPath === "assets" ||
  entryPath.startsWith("assets/");

const validateRelativeArchivePath = (entryPath: string) => {
  if (
    entryPath.length === 0 ||
    entryPath.includes("\0") ||
    entryPath.includes("\\") ||
    entryPath.startsWith("/") ||
    entryPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return managementError("extract-failed", "Plugin archive contains an unsafe path.", {
      entryPath,
    });
  }
  if (!isAllowedArchivePath(entryPath)) {
    return managementError("extract-failed", "Plugin archive contains an unsupported path.", {
      entryPath,
    });
  }
  return null;
};

// The semver-precedence comparator lives in @t3tools/contracts/plugin so the
// web catalog UI ranks versions identically; re-exported here for existing
// server-side importers.
export { compareSemver };

// Effectful, not a throw. This used to `throw managementError(...)`, but every caller
// invoked it inside an Effect.gen body or an Effect.succeed argument, where a
// synchronous throw is a DEFECT — it bypasses the typed failure channel entirely, so
// the callers' `Effect.mapError(...)` never saw it and a missing lockfile entry
// surfaced as an unhandled defect instead of "plugin-not-found".
const installedEntry = (
  entry: PluginLockfilePlugin | undefined,
): Effect.Effect<PluginLockfilePlugin, PluginManagementError> =>
  entry
    ? Effect.succeed(entry)
    : Effect.fail(managementError("plugin-not-found", "Plugin is not installed."));

const lockfileError = (cause: unknown) =>
  managementError(
    "lockfile",
    cause instanceof Error ? cause.message : "Plugin lockfile update failed.",
    {
      cause,
    },
  );

/**
 * Two plugin ids collide iff one's DB table prefix (`p_<id-with-underscores>_`)
 * is a prefix of the other's — the real namespacing invariant the migrator
 * enforces. A raw-id startsWith both falsely rejects distinct ids
 * ("chat"/"chatbot": `p_chat_` is NOT a prefix of `p_chatbot_`) and misses
 * hyphen aliasing ("test"/"test-plugin": `p_test_` IS a prefix of
 * `p_test_plugin_`, so they DO collide).
 */
export function pluginTablePrefixesCollide(idA: string, idB: string): boolean {
  const prefixA = pluginSqlPrefix(idA);
  const prefixB = pluginSqlPrefix(idB);
  return prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA);
}

function assertNoPluginIdCollision(
  pluginId: PluginIdType,
  installedIds: ReadonlyArray<string>,
  allowSameId: boolean,
) {
  for (const installedId of installedIds) {
    if (installedId === pluginId) {
      if (allowSameId) continue;
      throw managementError("manifest-invalid", "Plugin is already installed.", { pluginId });
    }
    if (pluginTablePrefixesCollide(pluginId, installedId)) {
      throw managementError("manifest-invalid", "Plugin id collides with an installed plugin id.", {
        pluginId,
        installedId,
      });
    }
  }
}

const assertHostCompatibility = (version: MarketplaceVersion, manifest: PluginManifest) => {
  if (!hostApiSatisfies(version.hostApi, HOST_API_VERSION)) {
    throw managementError(
      "manifest-invalid",
      "Marketplace version is not compatible with this host API.",
      {
        requested: version.hostApi,
        hostApiVersion: HOST_API_VERSION,
      },
    );
  }
  if (!hostApiSatisfies(manifest.hostApi, HOST_API_VERSION)) {
    throw managementError(
      "manifest-invalid",
      "Plugin manifest is not compatible with this host API.",
      {
        requested: manifest.hostApi,
        hostApiVersion: HOST_API_VERSION,
      },
    );
  }
  if (version.minAppVersion && compareSemver(packageJson.version, version.minAppVersion) < 0) {
    throw managementError("manifest-invalid", "Plugin version requires a newer app version.", {
      minAppVersion: version.minAppVersion,
      appVersion: packageJson.version,
    });
  }
  if (manifest.minAppVersion && compareSemver(packageJson.version, manifest.minAppVersion) < 0) {
    throw managementError("manifest-invalid", "Plugin manifest requires a newer app version.", {
      minAppVersion: manifest.minAppVersion,
      appVersion: packageJson.version,
    });
  }
};

const decompressTarball = (bytes: Uint8Array) =>
  Effect.tryPromise({
    try: async () => {
      if (!isGzip(bytes)) return bytes;
      // Cap the streamed output so a bomb is aborted before it exhausts memory.
      // Also bound by the ratio relative to the (already capped) input.
      const ratioCap = bytes.byteLength * DECOMPRESSION_RATIO_MAX;
      const cap = Math.min(EXTRACT_TOTAL_MAX_BYTES, Math.max(ratioCap, 512));
      return await gunzipCapped(bytes, cap);
    },
    catch: (cause) =>
      isPluginManagementError(cause)
        ? cause
        : managementError("extract-failed", "Failed to decompress plugin archive.", { cause }),
  });

const extractTar = (input: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly tarBytes: Uint8Array;
  readonly outputDir: string;
}) =>
  Effect.gen(function* () {
    let offset = 0;
    let totalSize = 0;
    while (offset + 512 <= input.tarBytes.byteLength) {
      const header = input.tarBytes.slice(offset, offset + 512);
      offset += 512;
      if (isZeroBlock(header)) break;

      const name = cString(header.slice(0, 100));
      const prefix = cString(header.slice(345, 500));
      const entryPath = prefix.length > 0 ? `${prefix}/${name}` : name;
      const size = octal(header.slice(124, 136));
      const typeFlag = String.fromCharCode(header[156] ?? 0);
      if (!Number.isFinite(size) || size < 0) {
        return yield* managementError(
          "extract-failed",
          "Plugin archive contains an invalid size.",
          {
            entryPath,
          },
        );
      }
      if (offset + size > input.tarBytes.byteLength) {
        return yield* managementError("extract-failed", "Plugin archive is truncated.", {
          entryPath,
        });
      }

      const pathError = validateRelativeArchivePath(entryPath);
      if (pathError) return yield* pathError;
      if (typeFlag === "2" || typeFlag === "1") {
        return yield* managementError("extract-failed", "Plugin archive may not contain links.", {
          entryPath,
        });
      }
      if (typeFlag !== "\0" && typeFlag !== "0" && typeFlag !== "5") {
        return yield* managementError(
          "extract-failed",
          "Plugin archive contains an unsupported entry.",
          {
            entryPath,
            typeFlag,
          },
        );
      }

      if (typeFlag === "5") {
        yield* input.fs.makeDirectory(input.path.join(input.outputDir, entryPath), {
          recursive: true,
        });
      } else {
        if (size > EXTRACT_FILE_MAX_BYTES) {
          return yield* managementError("extract-failed", "Plugin archive file is too large.", {
            entryPath,
            limit: EXTRACT_FILE_MAX_BYTES,
            actual: size,
          });
        }
        totalSize += size;
        if (totalSize > EXTRACT_TOTAL_MAX_BYTES) {
          return yield* managementError(
            "extract-failed",
            "Plugin archive extracted size is too large.",
            {
              limit: EXTRACT_TOTAL_MAX_BYTES,
              actual: totalSize,
            },
          );
        }
        const outputPath = input.path.join(input.outputDir, entryPath);
        yield* input.fs.makeDirectory(input.path.dirname(outputPath), { recursive: true });
        yield* input.fs.writeFile(outputPath, input.tarBytes.slice(offset, offset + size));
      }

      offset += Math.ceil(size / 512) * 512;
    }
  }).pipe(
    Effect.mapError((cause) =>
      isPluginManagementError(cause)
        ? cause
        : managementError("extract-failed", "Failed to extract plugin archive.", { cause }),
    ),
  );

export const make = Effect.fn("PluginInstaller.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const clock = yield* Clock.Clock;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lookup = yield* OutboundUrlLookup;
  const transport = yield* PluginHttpClientTransportService;
  const store = yield* PluginLockfileStore;
  const marketplace = yield* PluginMarketplace;
  const host = yield* PluginHost;
  const catalog = yield* PluginCatalog;
  const stages = yield* Ref.make(new Map<string, StageRecord>());
  const stagingRoot = path.join(config.pluginsDir, ".staging");

  // Stage records live only in this process's memory, so anything under
  // .staging at startup is unreachable by design (an interrupt/crash between
  // mkdir and record, or a removal that failed during cleanup). Reap it all
  // best-effort so orphans cannot accumulate across runs.
  yield* fs.remove(stagingRoot, { recursive: true, force: true }).pipe(Effect.ignore);

  const removePath = (target: string) =>
    fs
      .remove(target, { recursive: true, force: true })
      .pipe(
        Effect.mapError((cause) =>
          managementError("filesystem", "Failed to remove plugin path.", { target, cause }),
        ),
      );

  const cleanupExpired = Effect.gen(function* () {
    const now = yield* clock.currentTimeMillis;
    const expired = yield* Ref.modify(stages, (current) => {
      const next = new Map(current);
      const removed: Array<StageRecord> = [];
      for (const stage of current.values()) {
        if (stage.expiresAtMs <= now) {
          next.delete(stage.stageToken);
          removed.push(stage);
        }
      }
      return [removed, next];
    });
    // Removal is best-effort per directory: one stuck dir (EACCES, locked
    // file) must not fail the caller (getStage/beginInstall/confirm*) that
    // merely triggered cleanup. Leftovers are reaped by the startup sweep.
    yield* Effect.forEach(expired, (stage) => removePath(stage.stagingDir).pipe(Effect.ignore), {
      concurrency: 4,
      discard: true,
    });
  });

  const getStage = (stageToken: string, operation: StageRecord["operation"]) =>
    Effect.gen(function* () {
      yield* cleanupExpired;
      const stage = (yield* Ref.get(stages)).get(stageToken);
      if (!stage || stage.operation !== operation) {
        return yield* managementError("stage-not-found", "Plugin staging token was not found.", {
          stageToken,
        });
      }
      return stage;
    });

  // Claim a stage for a confirm: reap other expired stages, then atomically PIN
  // this one so its TTL can no longer expire. Without pinning, a concurrent call
  // (another getStage / beginInstall) runs cleanupExpired, which would reap this
  // very stage — deleting its record and stagingDir — if the TTL elapses between
  // the confirm's lookup and moveStagingToVersionDir's rename, failing a valid,
  // timely confirm with ENOENT. The stage stays in the map under the same token,
  // so the confirm's existing dropStage (success) / cleanupStage (error) paths are
  // unchanged; the startup sweep reaps a pinned stage orphaned by an interrupt.
  const claimStage = (stageToken: string, operation: StageRecord["operation"]) =>
    Effect.gen(function* () {
      yield* cleanupExpired;
      const claimed = yield* Ref.modify(stages, (current) => {
        const stage = current.get(stageToken);
        if (!stage || stage.operation !== operation) {
          return [null, current] as const;
        }
        const next = new Map(current);
        next.set(stageToken, { ...stage, expiresAtMs: Number.POSITIVE_INFINITY });
        return [stage, next] as const;
      });
      if (!claimed) {
        return yield* managementError("stage-not-found", "Plugin staging token was not found.", {
          stageToken,
        });
      }
      return claimed;
    });

  const dropStage = (stageToken: string) =>
    Ref.modify(stages, (current) => {
      const stage = current.get(stageToken);
      const next = new Map(current);
      next.delete(stageToken);
      return [stage, next] as const;
    });

  const readSources = Effect.gen(function* () {
    const lockfile = yield* store.readLockfile.pipe(Effect.mapError(lockfileError));
    return lockfile.sources;
  });

  const sourceById = (sourceId: string) =>
    Effect.gen(function* () {
      const source = (yield* readSources).find((candidate) => candidate.id === sourceId);
      if (!source) {
        return yield* managementError("source-not-found", "Plugin source was not found.", {
          sourceId,
        });
      }
      return source;
    });

  const downloadBytes = (url: string) => {
    if (url.startsWith("file:")) {
      return fs.readFile(NodeURL.fileURLToPath(url)).pipe(
        Effect.mapError((cause) =>
          managementError("download-failed", "Failed to read plugin tarball file.", {
            url,
            cause,
          }),
        ),
      );
    }
    // Tarball URLs come from untrusted marketplace.json data: fetch them
    // through the SSRF guard (per-hop URL validation + DNS-pinned transport,
    // redirects re-validated) instead of the raw host HttpClient, which would
    // happily follow a 30x into loopback/private/metadata addresses.
    return guardedOutboundHttpGet({ url, lookup, transport, timeoutMs: DOWNLOAD_TIMEOUT_MS }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "OutboundUrlError"
          ? managementError(
              "download-failed",
              `Plugin tarball URL is not allowed: ${cause.reason}.`,
              {
                url,
              },
            )
          : managementError("download-failed", "Failed to download plugin tarball.", {
              url,
              cause,
            }),
      ),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError((cause) =>
        isPluginManagementError(cause)
          ? cause
          : managementError("download-failed", "Plugin tarball returned a non-OK response.", {
              url,
              cause,
            }),
      ),
      Effect.flatMap((response) =>
        readHttpResponseBytesCapped({
          response,
          maxBytes: DOWNLOAD_MAX_BYTES,
          tooLarge: (actual) =>
            managementError("download-failed", "Plugin tarball is too large.", {
              url,
              limit: DOWNLOAD_MAX_BYTES,
              actual,
            }),
          readFailed: (cause) =>
            managementError("download-failed", "Failed to read plugin tarball body.", {
              url,
              cause,
            }),
        }),
      ),
      // Hard wall-clock deadline around the whole download + body read. The
      // transport `timeoutMs` only bounds SOCKET INACTIVITY (it resets on every
      // byte), so a byte-drip endpoint could hold an install open forever while
      // staying under the byte cap. Same defense HttpClientCapability.ts
      // (~313-364) documents for this attack.
      Effect.timeoutOrElse({
        duration: Duration.millis(DOWNLOAD_TIMEOUT_MS),
        orElse: () =>
          managementError("download-failed", "Plugin tarball download exceeded the time limit.", {
            url,
            timeoutMs: DOWNLOAD_TIMEOUT_MS,
          }),
      }),
    );
  };

  const readManifest = (stagingDir: string) =>
    fs.readFileString(pluginManifestPath(stagingDir, path.join)).pipe(
      Effect.mapError((cause) =>
        managementError("manifest-invalid", "Plugin archive is missing manifest.json.", { cause }),
      ),
      Effect.flatMap((raw) =>
        decodeManifestJson(raw).pipe(
          Effect.mapError((cause) =>
            managementError("manifest-invalid", "Plugin manifest is invalid.", { cause }),
          ),
        ),
      ),
    );

  const validateManifest = (input: {
    readonly operation: StageRecord["operation"];
    readonly requestedPluginId: PluginIdType;
    readonly requestedVersion: string;
    readonly manifest: PluginManifest;
    readonly marketplaceVersion: MarketplaceVersion;
  }) =>
    Effect.gen(function* () {
      if (input.manifest.id !== input.requestedPluginId) {
        return yield* managementError(
          "manifest-invalid",
          "Plugin manifest id does not match the request.",
          {
            expected: input.requestedPluginId,
            actual: input.manifest.id,
          },
        );
      }
      if (input.manifest.version !== input.requestedVersion) {
        return yield* managementError(
          "manifest-invalid",
          "Plugin manifest version does not match the request.",
          {
            expected: input.requestedVersion,
            actual: input.manifest.version,
          },
        );
      }
      yield* Effect.try({
        try: () => assertHostCompatibility(input.marketplaceVersion, input.manifest),
        catch: (cause) =>
          isPluginManagementError(cause)
            ? cause
            : managementError("manifest-invalid", "Plugin manifest compatibility check failed.", {
                cause,
              }),
      });

      const lockfile = yield* store.readLockfile.pipe(Effect.mapError(lockfileError));
      yield* Effect.try({
        try: () =>
          assertNoPluginIdCollision(
            input.requestedPluginId,
            Object.keys(lockfile.plugins),
            input.operation === "upgrade",
          ),
        catch: (cause) =>
          isPluginManagementError(cause)
            ? cause
            : managementError("manifest-invalid", "Plugin id collision check failed.", { cause }),
      });
    });

  const stageTarball = (input: {
    readonly operation: StageRecord["operation"];
    readonly sourceId: string;
    readonly pluginId: PluginIdType;
    readonly version: string;
    readonly tarballUrl: string;
    readonly marketplaceVersion: MarketplaceVersion;
  }) =>
    Effect.gen(function* () {
      yield* cleanupExpired;
      const downloaded = yield* downloadBytes(input.tarballUrl);
      if (downloaded.byteLength > DOWNLOAD_MAX_BYTES) {
        return yield* managementError("download-failed", "Plugin tarball is too large.", {
          limit: DOWNLOAD_MAX_BYTES,
          actual: downloaded.byteLength,
        });
      }
      const actualSha = sha256Hex(downloaded);
      if (actualSha.toLowerCase() !== input.marketplaceVersion.sha256.toLowerCase()) {
        return yield* managementError(
          "checksum-mismatch",
          "Plugin tarball checksum did not match.",
          {
            expected: input.marketplaceVersion.sha256,
            actual: actualSha,
          },
        );
      }

      const stageToken = NodeCrypto.randomUUID();
      const stagingDir = path.join(stagingRoot, stageToken);
      yield* fs.remove(stagingDir, { recursive: true, force: true }).pipe(
        Effect.andThen(fs.makeDirectory(stagingDir, { recursive: true })),
        Effect.mapError((cause) =>
          managementError("filesystem", "Failed to create plugin staging directory.", {
            stagingDir,
            cause,
          }),
        ),
      );

      const tarBytes = yield* decompressTarball(downloaded).pipe(
        // Clean up the just-created staging dir if decompression fails (corrupt
        // archive / gzip-bomb cap). Without this the dir orphans on disk with no
        // StageRecord, so cleanupExpired can never reap it.
        Effect.catch((error) => removePath(stagingDir).pipe(Effect.andThen(Effect.fail(error)))),
      );
      yield* extractTar({ fs, path, tarBytes, outputDir: stagingDir }).pipe(
        Effect.catch((error) => removePath(stagingDir).pipe(Effect.andThen(Effect.fail(error)))),
      );
      const manifest = yield* readManifest(stagingDir).pipe(
        Effect.catch((error) => removePath(stagingDir).pipe(Effect.andThen(Effect.fail(error)))),
      );
      yield* validateManifest({
        operation: input.operation,
        requestedPluginId: input.pluginId,
        requestedVersion: input.version,
        manifest,
        marketplaceVersion: input.marketplaceVersion,
      }).pipe(
        Effect.catch((error) => removePath(stagingDir).pipe(Effect.andThen(Effect.fail(error)))),
      );

      const now = yield* clock.currentTimeMillis;
      yield* Ref.update(stages, (current) => {
        const next = new Map(current);
        next.set(stageToken, {
          operation: input.operation,
          stageToken,
          sourceId: input.sourceId,
          pluginId: input.pluginId,
          version: input.version,
          sha256: input.marketplaceVersion.sha256,
          stagingDir,
          expiresAtMs: now + STAGE_TOKEN_TTL_MS,
          manifest,
        });
        return next;
      });

      return {
        stageToken,
        manifest,
        capabilityDescriptions: Object.fromEntries(
          manifest.capabilities.map((capability) => [
            capability,
            PLUGIN_CAPABILITY_DESCRIPTIONS[capability],
          ]),
        ) as Record<string, string>,
      };
    });

  const pluginInfo = (pluginId: PluginIdType) =>
    catalog.list.pipe(
      Effect.map((plugins) => plugins.find((plugin) => plugin.id === pluginId)),
      Effect.flatMap((plugin) =>
        plugin
          ? Effect.succeed(plugin)
          : Effect.fail(
              managementError("plugin-not-found", "Installed plugin metadata was not found.", {
                pluginId,
              }),
            ),
      ),
    );

  const moveStagingToVersionDir = (stage: StageRecord) =>
    Effect.gen(function* () {
      const destination = pluginVersionDir(
        config.pluginsDir,
        stage.pluginId,
        stage.version,
        path.join,
      );
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      // Remove any pre-existing version dir (reinstall / interrupted prior
      // move) so rename cannot fail with ENOTEMPTY on an occupied destination.
      yield* fs.remove(destination, { recursive: true, force: true });
      yield* fs.rename(stage.stagingDir, destination);
    }).pipe(
      Effect.mapError((cause) =>
        managementError("filesystem", "Failed to move staged plugin into place.", {
          pluginId: stage.pluginId,
          version: stage.version,
          cause,
        }),
      ),
    );

  // Drop the stage token and best-effort remove its staging dir. Run on any
  // confirm failure so a failed confirm never leaves a dangling record or dir.
  const cleanupStage = (stageToken: string) =>
    dropStage(stageToken).pipe(
      Effect.flatMap((stage) =>
        stage ? removePath(stage.stagingDir).pipe(Effect.ignore) : Effect.void,
      ),
    );

  const beginInstall: PluginInstaller["Service"]["beginInstall"] = (input) =>
    Effect.gen(function* () {
      const source = yield* sourceById(input.sourceId);
      const found = yield* marketplace.findVersion({
        source,
        pluginId: input.pluginId,
        version: input.version,
      });
      return yield* stageTarball({
        operation: "install",
        sourceId: input.sourceId,
        pluginId: input.pluginId,
        version: input.version,
        tarballUrl: found.tarballUrl,
        marketplaceVersion: found.version,
      });
    });

  // confirmInstall's success guarantees only that the tarball bytes are moved
  // into the version dir and the lockfile entry is committed. It does NOT
  // guarantee the plugin activated: activatePlugin swallows load failures by
  // design (marking the plugin failed in its own state), so the durable install
  // is already complete before activation is attempted. The "activation-failed"
  // mapping below is therefore effectively reachable only for host lockfile
  // read/parse errors, not for a plugin whose code failed to load.
  const confirmInstall: PluginInstaller["Service"]["confirmInstall"] = (stageToken) =>
    Effect.gen(function* () {
      // Armed only for the window between "files moved into the version dir" and
      // "lockfile entry written". If the commit fails there, the moved files
      // would otherwise orphan on disk with no lockfile entry. Once the entry is
      // written it owns the files, so we disarm (a later activation failure must
      // NOT delete files a committed entry points at). Never remove a dir that
      // pre-existed the move.
      let orphanedVersionDir: string | null = null;
      return yield* Effect.gen(function* () {
        const stage = yield* claimStage(stageToken, "install");
        const destination = pluginVersionDir(
          config.pluginsDir,
          stage.pluginId,
          stage.version,
          path.join,
        );
        const installedAt = DateTime.formatIso(yield* DateTime.now);
        yield* store
          .updatePlugin(stage.pluginId, ({ lockfile }) =>
            // Validate AND move inside the lockfile single-writer, in that order.
            //
            // The move is destructive (it removes any existing version dir before
            // renaming), so running it before this callback let two concurrent
            // confirms for the same id+version corrupt each other: the loser wiped
            // the winner's already-committed directory, replaced it with its own
            // rejected archive, and then failed the collision check — leaving disk
            // contents that no longer match the checksum the lockfile records. The
            // orphan cleanup could not help, because the loser saw the destination
            // as pre-existing and correctly refused to delete it. Under the
            // single-writer the loser fails the check BEFORE touching anything.
            Effect.gen(function* () {
              yield* Effect.try({
                try: () =>
                  assertNoPluginIdCollision(stage.pluginId, Object.keys(lockfile.plugins), false),
                catch: (cause) =>
                  isPluginManagementError(cause)
                    ? cause
                    : managementError("manifest-invalid", "Plugin id collision check failed.", {
                        cause,
                      }),
              });
              // Re-validate the source under the lockfile writer. removeSource's
              // in-use check only sees committed lockfile.plugins, so a source can
              // be removed in the begin→confirm window of an install (the stage is
              // in-memory only, invisible to that check). Committing an entry whose
              // sourceId no longer resolves strands it from checkUpdates and
              // beginUpgrade, so reject before writing.
              if (!lockfile.sources.some((source) => source.id === stage.sourceId)) {
                return yield* managementError(
                  "source-not-found",
                  "Plugin source was removed before the install was confirmed.",
                  { sourceId: stage.sourceId },
                );
              }
              const preexisted = yield* fs
                .exists(destination)
                .pipe(Effect.orElseSucceed(() => false));
              yield* moveStagingToVersionDir(stage);
              if (!preexisted) orphanedVersionDir = destination;
              return {
                version: stage.version,
                sha256: stage.sha256,
                sourceId: stage.sourceId,
                enabled: true,
                state: "active" as const,
                activation: { activatingSince: null, crashCount: 0 },
                installedAt,
                lastError: null,
              };
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              isPluginManagementError(cause) ? cause : lockfileError(cause),
            ),
            // The move+commit region must be atomic w.r.t. interruption. Neither
            // the store's mutate nor this confirm otherwise masks it, and the
            // tapError cleanup below only runs on typed failures, not interrupts.
            // An interrupt after moveStagingToVersionDir's rename but before the
            // lockfile write commits would strand the install: an orphaned version
            // dir with no lockfile entry, plus a stage record pointing at a staging
            // dir that no longer exists, so a retry with the same token fails
            // ENOENT. The region is small (O(1) same-fs rename + atomic temp+rename
            // lockfile write); scope uninterruptible to this call site so other
            // mutations keep the store's default interruptibility.
            Effect.uninterruptible,
          );
        orphanedVersionDir = null;
        yield* dropStage(stageToken);
        yield* host
          .activatePlugin(stage.pluginId)
          .pipe(
            Effect.mapError((cause) =>
              managementError("activation-failed", "Plugin activation failed.", { cause }),
            ),
          );
        return { plugin: yield* pluginInfo(stage.pluginId) };
      }).pipe(
        Effect.tapError(() =>
          cleanupStage(stageToken).pipe(
            Effect.andThen(
              orphanedVersionDir === null
                ? Effect.void
                : removePath(orphanedVersionDir).pipe(Effect.ignore),
            ),
          ),
        ),
      );
    });

  const abortInstall: PluginInstaller["Service"]["abortInstall"] = (stageToken) =>
    Effect.gen(function* () {
      const stage = yield* dropStage(stageToken);
      if (stage) {
        yield* removePath(stage.stagingDir);
      }
    });

  const setEnabled: PluginInstaller["Service"]["setEnabled"] = (input) =>
    Effect.gen(function* () {
      // Persist + activate/deactivate MUST be atomic per plugin. Doing the write
      // here and then calling activatePlugin/deactivatePlugin (which take the
      // activation lock separately) let two concurrent setEnabled calls interleave
      // between the write and the host action, stranding the plugin as
      // lockfile-enabled with no runtime and disable intent stuck. The host runs
      // both halves under one lock acquisition; we still own the lockfile shape.
      const persist = store
        .updatePlugin(input.pluginId, ({ current }) =>
          installedEntry(current).pipe(
            Effect.flatMap((entry) =>
              // A pending-remove entry is mid-uninstall (persist written, teardown
              // in flight). Re-enabling it would resurrect a plugin the user asked
              // to remove — final lockfile active/enabled while reconcile still
              // deletes it. Reject the late enable so uninstall wins.
              input.enabled && entry.state === "pending-remove"
                ? Effect.fail(
                    managementError("manifest-invalid", "Plugin is pending removal.", {
                      pluginId: input.pluginId,
                    }),
                  )
                : Effect.succeed({
                    ...entry,
                    enabled: input.enabled,
                    state: input.enabled ? ("active" as const) : ("disabled" as const),
                    lastError: input.enabled ? null : entry.lastError,
                    activation: input.enabled
                      ? { activatingSince: null, crashCount: 0 }
                      : entry.activation,
                  }),
            ),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            isPluginManagementError(cause) ? cause : lockfileError(cause),
          ),
          Effect.asVoid,
        );

      if (input.enabled) {
        yield* host.setPluginEnabled(input.pluginId, true, persist).pipe(
          // `persist` already fails as a PluginManagementError; only the host's own
          // lockfile read/parse failures need wrapping as activation failures.
          Effect.mapError((error) =>
            error._tag === "PluginLockfileReadError" || error._tag === "PluginLockfileCorruptError"
              ? managementError("activation-failed", "Plugin activation failed.", { cause: error })
              : error,
          ),
        );
      } else {
        yield* host
          .setPluginEnabled(input.pluginId, false, persist)
          .pipe(
            Effect.mapError((error) =>
              error._tag === "PluginLockfileReadError" ||
              error._tag === "PluginLockfileCorruptError"
                ? lockfileError(error)
                : error,
            ),
          );
      }
    });

  const uninstall: PluginInstaller["Service"]["uninstall"] = (input) =>
    Effect.gen(function* () {
      const markerPath = path.join(config.pluginsDir, input.pluginId, PRESERVE_DATA_MARKER);
      if (!input.removeData) {
        yield* fs.makeDirectory(path.dirname(markerPath), { recursive: true }).pipe(
          Effect.andThen(fs.writeFileString(markerPath, "")),
          Effect.mapError((cause) =>
            managementError("filesystem", "Failed to record plugin data preservation intent.", {
              pluginId: input.pluginId,
              cause,
            }),
          ),
        );
      } else {
        // The LATEST request wins. A marker written by an earlier keep-my-data
        // uninstall used to survive a retry with removeData: true, so reconcile
        // preserved data the user had just asked to delete — and, like the settings
        // row before it, a reinstall would quietly resurrect it. Failing loudly for
        // the same reason remove() does: reconcile trusts what is on disk.
        yield* fs.remove(markerPath, { force: true }).pipe(
          Effect.mapError((cause) =>
            managementError("filesystem", "Failed to clear plugin data preservation intent.", {
              pluginId: input.pluginId,
              cause,
            }),
          ),
        );
      }
      // Persist pending-remove AND tear down the live runtime under ONE
      // activation-lock acquisition (see PluginHost.setPluginEnabled). Writing
      // pending-remove here and calling deactivatePlugin separately let a
      // concurrent setEnabled(true) interleave between the two — its persist only
      // checks the entry EXISTS — leaving the lockfile active/enabled with no
      // runtime. Routing the pending-remove write through setPluginEnabled makes
      // uninstall's persist+teardown atomic with any concurrent enable/disable.
      const persist = store
        .updatePlugin(input.pluginId, ({ current }) =>
          installedEntry(current).pipe(
            Effect.map((entry) => ({
              ...entry,
              state: "pending-remove" as const,
              enabled: false,
            })),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            isPluginManagementError(cause) ? cause : lockfileError(cause),
          ),
          Effect.asVoid,
        );
      yield* host
        .setPluginEnabled(input.pluginId, false, persist)
        .pipe(
          Effect.mapError((error) =>
            error._tag === "PluginLockfileReadError" || error._tag === "PluginLockfileCorruptError"
              ? lockfileError(error)
              : error,
          ),
        );
    });

  const beginUpgrade: PluginInstaller["Service"]["beginUpgrade"] = (input) =>
    Effect.gen(function* () {
      const lockfile = yield* store.readLockfile.pipe(Effect.mapError(lockfileError));
      const current = yield* installedEntry(lockfile.plugins[input.pluginId]);
      // Reject upgrading to the already-installed version. Staging + confirming a
      // same-version upgrade would move the new files onto the LIVE version dir
      // (moveStagingToVersionDir removes the destination first), destroying the
      // running plugin's files with no safe rollback. Reject before any staging.
      if (input.version === current.version) {
        return yield* managementError(
          "manifest-invalid",
          "Plugin is already installed at this version.",
          { pluginId: input.pluginId, version: input.version },
        );
      }
      const source = lockfile.sources.find((candidate) => candidate.id === current.sourceId);
      if (!source) {
        return yield* managementError(
          "source-not-found",
          "Installed plugin source was not found.",
          {
            sourceId: current.sourceId,
          },
        );
      }
      const found = yield* marketplace.findVersion({
        source,
        pluginId: input.pluginId,
        version: input.version,
      });
      return yield* stageTarball({
        operation: "upgrade",
        sourceId: current.sourceId,
        pluginId: input.pluginId,
        version: input.version,
        tarballUrl: found.tarballUrl,
        marketplaceVersion: found.version,
      });
    });

  const confirmUpgrade: PluginInstaller["Service"]["confirmUpgrade"] = (stageToken) =>
    Effect.gen(function* () {
      // See confirmInstall: only the moved-but-not-yet-recorded window can orphan
      // the new version dir. The staged version dir is distinct from the running
      // version, so removing it on failure never touches the live plugin.
      let orphanedVersionDir: string | null = null;
      return yield* Effect.gen(function* () {
        const stage = yield* claimStage(stageToken, "upgrade");
        const destination = pluginVersionDir(
          config.pluginsDir,
          stage.pluginId,
          stage.version,
          path.join,
        );
        const stagedAt = DateTime.formatIso(yield* DateTime.now);
        yield* store
          .updatePlugin(stage.pluginId, ({ current }) =>
            // Same discipline as confirmInstall: the destructive move happens under
            // the lockfile single-writer, so two concurrent upgrade confirms cannot
            // interleave "remove the other's committed dir" with "record my sha".
            Effect.gen(function* () {
              const entry = yield* installedEntry(current);
              // Uninstall wins the race: a pending-remove entry is mid-teardown
              // (persist written, reconciliation may already be deleting the
              // plugin). Overwriting it with pending-upgrade here would cancel the
              // uninstall and move new files while teardown is still in flight,
              // leaving a half-removed plugin. setEnabled rejects late enables on
              // pending-remove for the same reason — mirror that here.
              if (entry.state === "pending-remove") {
                return yield* managementError(
                  "manifest-invalid",
                  "This plugin is being uninstalled and can no longer be upgraded.",
                  { pluginId: stage.pluginId },
                );
              }
              // Reject a second confirm for the same plugin while an upgrade is
              // already staged. Two upgrades begun from the same installed version
              // (v1→v2 and v1→v3) both pass installedEntry — the version never
              // changes during pending-upgrade — so without this guard the later
              // confirm's last-writer-wins overwrite of `staged`/state orphans the
              // earlier confirm's already-moved version dir.
              if (entry.state === "pending-upgrade") {
                return yield* managementError(
                  "manifest-invalid",
                  "An upgrade is already pending for this plugin.",
                  { pluginId: stage.pluginId },
                );
              }
              const preexisted = yield* fs
                .exists(destination)
                .pipe(Effect.orElseSucceed(() => false));
              yield* moveStagingToVersionDir(stage);
              if (!preexisted) orphanedVersionDir = destination;
              return {
                ...entry,
                state: "pending-upgrade" as const,
                staged: {
                  version: stage.version,
                  sha256: stage.sha256,
                  stagedAt,
                },
              };
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              isPluginManagementError(cause) ? cause : lockfileError(cause),
            ),
            // Same discipline as confirmInstall: the destructive move + lockfile
            // commit must be atomic w.r.t. interruption. An interrupt after the
            // rename but before the write would orphan the staged version dir with
            // no lockfile entry and leave the stage pointing at a vanished staging
            // dir, so a same-token retry fails ENOENT. Scoped to this call site.
            Effect.uninterruptible,
          );
        orphanedVersionDir = null;
        yield* dropStage(stageToken);
        return { plugin: yield* pluginInfo(stage.pluginId) };
      }).pipe(
        Effect.tapError(() =>
          cleanupStage(stageToken).pipe(
            Effect.andThen(
              orphanedVersionDir === null
                ? Effect.void
                : removePath(orphanedVersionDir).pipe(Effect.ignore),
            ),
          ),
        ),
      );
    });

  const checkUpdates = Effect.gen(function* () {
    const lockfile = yield* store.readLockfile.pipe(Effect.mapError(lockfileError));
    const updates = yield* Effect.forEach(
      Object.entries(lockfile.plugins),
      ([rawPluginId, entry]) =>
        Effect.gen(function* () {
          const pluginId = PluginId.make(rawPluginId);
          const source = lockfile.sources.find((candidate) => candidate.id === entry.sourceId);
          if (!source) return null;
          const index = yield* marketplace
            .fetchSource(source)
            .pipe(Effect.orElseSucceed(() => null));
          if (index === null) return null;
          const marketplaceEntry = index.plugins.find((candidate) => candidate.id === pluginId);
          if (!marketplaceEntry) return null;
          // Prereleases are only offered as updates when the installed version
          // is itself a prerelease; a stable install must not be prompted onto
          // an rc/beta channel.
          const includePrereleases = isPrereleaseVersion(entry.version);
          const latest = marketplaceEntry.versions
            .filter((candidate) => includePrereleases || !isPrereleaseVersion(candidate.version))
            .toSorted((left, right) => compareSemver(right.version, left.version))[0];
          if (!latest || compareSemver(latest.version, entry.version) <= 0) return null;
          return {
            pluginId,
            currentVersion: entry.version,
            latestVersion: latest.version,
          };
        }),
      { concurrency: 4 },
    );
    return { updates: updates.filter((update) => update !== null) };
  });

  return PluginInstaller.of({
    beginInstall,
    confirmInstall,
    abortInstall,
    setEnabled,
    uninstall,
    beginUpgrade,
    confirmUpgrade,
    checkUpdates,
  });
});

export { PRESERVE_DATA_MARKER };
export const layer = Layer.effect(PluginInstaller, make());
