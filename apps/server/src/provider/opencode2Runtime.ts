import type { ChatAttachment, RuntimeMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as P from "effect/Predicate";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Model, OpenCode, Permission } from "@opencode/client/effect";
import { Service as OpenCodeLocalService } from "@opencode/client/effect/service";
import type { OpenCodeClient } from "@opencode/client/effect";

/**
 * OpenCode 2 runtime: connection management for the machine's background
 * service (or an explicit external server), plus inventory loading and the
 * runtime-mode → session permission rules translation.
 *
 * Unlike the v1 runtime there is no process management here: v2's
 * architecture is one shared background server owning sessions, plugins,
 * permissions, and durable state. `Service.ensure` starts it when missing.
 */
export interface OpenCode2Connection {
  readonly client: OpenCodeClient;
  readonly url: string;
  readonly external: boolean;
  /** Server version from `health.get`, resolved at connect time. */
  readonly version: string;
}

const OPENCODE2_RUNTIME_ERROR_TAG = "OpenCode2RuntimeError";
export class OpenCode2RuntimeError extends Data.TaggedError(OPENCODE2_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCode2RuntimeError =>
    P.isTagged(u, OPENCODE2_RUNTIME_ERROR_TAG);
}

const OPENCODE2_CONNECT_TIMEOUT = "10 seconds";

/** Only 2.x servers speak the v2 API; the same gate drives service discovery. */
const isOpenCode2Version = (version: string): boolean => version.startsWith("2.");

/**
 * v2 session rules for a T3 runtime mode. Session rules are evaluated after
 * agent rules with last-match-wins, server-enforced, so they cannot be
 * overridden by user config, agent definitions, or saved approvals — this is
 * what makes supervised modes trustworthy on a shared background service.
 *
 * Cross-thread isolation: per-thread-named registrations are visible to every
 * session in the directory, and each carries its target thread's credential,
 * so a session must never call another thread's. Every T3 registration lives
 * under the reserved `OPENCODE2_MCP_NAMESPACE`, so one constant deny covers all
 * threads *and* all colocated instances — a per-instance pattern could not,
 * since neither adapter knows the other's configured name. This holds in every
 * mode including `full-access`: skipping approvals is about this thread's own
 * work, not about letting it act as another thread.
 */
export function buildOpenCode2SessionRules(input: {
  readonly runtimeMode: RuntimeMode;
  /** This thread's own registration, allowed within the reserved namespace. */
  readonly ownMcpServerName?: string | undefined;
}): Permission.Ruleset {
  // Everything T3 registers, from any instance or thread, is denied by
  // default. The own-server rule is emitted after it and wins by last-match.
  const foreignDeny: Permission.Ruleset = [
    { action: `${OPENCODE2_MCP_NAMESPACE}-*`, resource: "*", effect: "deny" },
  ];
  // Full access stays prompt-free, so the thread's own tools are auto-allowed
  // rather than surfaced as an approval — but the cross-thread deny remains.
  const ownRule = (effect: "ask" | "allow"): Permission.Ruleset =>
    input.ownMcpServerName
      ? [{ action: `${input.ownMcpServerName}_*`, resource: "*", effect }]
      : [];

  if (input.runtimeMode === "full-access") {
    return [...foreignDeny, ...ownRule("allow")];
  }
  const editEffect =
    input.runtimeMode === "auto-accept-edits" ? ("allow" as const) : ("ask" as const);
  return [
    // Catch-all ask first; the specific rules below win as later matches.
    { action: "*", resource: "*", effect: "ask" },
    ...foreignDeny,
    ...ownRule("ask"),
    // Read-only discovery stays frictionless.
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "question", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "allow" },
    // OpenCode's own default keeps .env files behind a prompt.
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    { action: "edit", resource: "*", effect: editEffect },
  ];
}

/**
 * Reserved namespace holding every T3 MCP registration on an OpenCode server.
 * Isolation rules match this prefix and nothing else; a user-configured
 * `mcpServerName` nests inside it rather than replacing it, so instances that
 * configure different names still deny each other's registrations.
 */
export const OPENCODE2_MCP_NAMESPACE = "t3-code";
/** MCP names must stay short and filename-safe; hash beyond this length. */
const OPENCODE2_MCP_NAME_MAX_LENGTH = 96;

/**
 * Sanitized MCP naming base, shared by the registration name and the isolation
 * rules. Both must agree on this value: the sanitizer rewrites the configured
 * name too (`corp.io` → `corp_io`), so rules derived from the raw setting
 * would not match the registered server.
 */
export function openCode2McpServerBase(baseName: string | undefined): string {
  const trimmed = baseName?.trim();
  const label =
    trimmed && trimmed.length > 0
      ? `${OPENCODE2_MCP_NAMESPACE}-${trimmed}`
      : OPENCODE2_MCP_NAMESPACE;
  return label.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Deterministic per-thread MCP server name on a shared OpenCode server. MCP
 * names allow letters, digits, `_`, and `-`; the base is sanitized so the
 * isolation rules can predict it, and the thread id is hashed beyond the
 * length cap so two threads in one directory hold independent registrations.
 */
export function openCode2McpServerName(baseName: string | undefined, threadId: string): string {
  const base = openCode2McpServerBase(baseName);
  const name = `${base}-${threadId}`.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  if (name.length <= OPENCODE2_MCP_NAME_MAX_LENGTH) {
    return name;
  }
  // FNV-1a over base and thread id keeps the name stable across restarts and
  // distinct when a long configured base is truncated. The hash is hex, so the
  // already-sanitized base keeps the result a valid name.
  const hashInput = `${base}-${threadId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < hashInput.length; index += 1) {
    hash ^= hashInput.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const suffix = hash.toString(16).padStart(8, "0");
  const prefixLength = OPENCODE2_MCP_NAME_MAX_LENGTH - suffix.length - 1;
  return `${base.slice(0, prefixLength)}-${suffix}`;
}

export interface OpenCode2Inventory {
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly providerId: string;
    readonly name: string;
    /** Variant ids the model accepts; v2 rejects any other in the model ref. */
    readonly variants: ReadonlyArray<string>;
  }>;
  readonly skills: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | null;
    readonly location: string;
  }>;
}

export class OpenCode2Runtime extends Context.Service<
  OpenCode2Runtime,
  {
    /**
     * Connect to the OpenCode server used by this provider instance: the
     * explicitly configured external `serverUrl`, or the machine's background
     * service (discovered, or started when absent). Connections are plain HTTP
     * against an externally-owned server; nothing is held open by T3.
     */
    readonly connect: (input: {
      readonly serverUrl?: string | null;
      readonly serverPassword?: string;
      /** Path to the v2 binary used to start the background service when none is registered. */
      readonly binaryPath?: string;
    }) => Effect.Effect<OpenCode2Connection, OpenCode2RuntimeError>;
    /** Load model/agent/skill inventory from the same connection chat uses. */
    readonly loadInventory: (input: {
      readonly client: OpenCodeClient;
      readonly directory: string;
    }) => Effect.Effect<OpenCode2Inventory, OpenCode2RuntimeError>;
  }
>()("t3/provider/opencode2Runtime") {}

function ensureRuntimeError(
  operation: OpenCode2RuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCode2RuntimeError {
  return OpenCode2RuntimeError.is(cause)
    ? cause
    : new OpenCode2RuntimeError({ operation, detail, cause });
}

const basicAuthHeader = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;

const makeOpenCode2Runtime = Effect.gen(function* () {
  // Acquire the platform services once here so the service's methods have no
  // requirements channel — mirrors the v1 runtime layer providing `NetService`.
  const httpClient = yield* HttpClient.HttpClient;
  // The client package's local-service discovery reads the registration file
  // through this FileSystem when connect() falls through to discover().
  const fileSystem = yield* FileSystem.FileSystem;

  const clientFor = (
    url: string,
    headers: Record<string, string>,
  ): Effect.Effect<OpenCodeClient, never, HttpClient.HttpClient> =>
    OpenCode.make({ baseUrl: url }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.mapRequest(httpClient, (request) =>
          HttpClientRequest.setHeaders(request, headers),
        ),
      ),
    );

  /**
   * `health.get` is the connection's liveness + version probe in v2. A healthy
   * v1 server answers it too, so the version is gated here: adopting one would
   * only fail later, on the first v2-only call.
   */
  const probeConnection = (client: OpenCodeClient) =>
    client.health.get().pipe(
      Effect.timeout(OPENCODE2_CONNECT_TIMEOUT),
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "connect",
          "The OpenCode server did not respond to a health probe.",
          cause,
        ),
      ),
      Effect.flatMap((health) =>
        isOpenCode2Version(health.version)
          ? Effect.succeed(health.version)
          : Effect.fail(
              new OpenCode2RuntimeError({
                operation: "connect",
                detail: `The OpenCode server reports version ${health.version}, but OpenCode 2 requires a 2.x server.`,
              }),
            ),
      ),
    );

  const connectExternal = (url: string, password: string | undefined) =>
    Effect.gen(function* () {
      const headers = password ? { authorization: basicAuthHeader("opencode", password) } : {};
      const client = yield* clientFor(url, headers);
      const version = yield* probeConnection(client);
      return { client, url, external: true, version } satisfies OpenCode2Connection;
    });

  const connectBackgroundService = (binaryPath: string | undefined) =>
    Effect.gen(function* () {
      // A registered v1 service is skipped here so `ensure` below replaces it
      // with a v2 one instead of this adapter adopting it.
      const discovered = yield* OpenCodeLocalService.discover({
        version: isOpenCode2Version,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.mapError((cause) =>
          ensureRuntimeError("connect", "Failed to read the local service registration.", cause),
        ),
      );
      if (discovered) {
        const headers = discovered.auth
          ? { authorization: basicAuthHeader(discovered.auth.username, discovered.auth.password) }
          : {};
        const client = yield* clientFor(discovered.url, headers);
        const version = yield* probeConnection(client);
        return {
          client,
          url: discovered.url,
          external: false,
          version,
        } satisfies OpenCode2Connection;
      }
      const command = openCode2ServiceCommand(binaryPath);
      const endpoint = yield* OpenCodeLocalService.ensure({
        version: isOpenCode2Version,
        ...(command ? { command } : {}),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.mapError((cause) =>
          ensureRuntimeError(
            "connect",
            "No OpenCode background service is registered and starting one failed.",
            cause,
          ),
        ),
      );
      const headers = OpenCodeLocalService.headers(endpoint) ?? {};
      const client = yield* clientFor(endpoint.url, headers);
      const version = yield* probeConnection(client);
      return {
        client,
        url: endpoint.url,
        external: false,
        version,
      } satisfies OpenCode2Connection;
    });

  const connect: OpenCode2Runtime["Service"]["connect"] = (input) =>
    Effect.gen(function* () {
      const serverUrl = input.serverUrl?.trim();
      if (serverUrl && serverUrl.length > 0) {
        return yield* connectExternal(
          serverUrl,
          input.serverPassword && input.serverPassword.length > 0
            ? input.serverPassword
            : undefined,
        );
      }
      return yield* connectBackgroundService(input.binaryPath);
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  const loadInventory: OpenCode2Runtime["Service"]["loadInventory"] = (input) =>
    Effect.gen(function* () {
      const { client, directory } = input;
      const location = { directory };

      const modelPage = yield* client.model
        .list({ location })
        .pipe(
          Effect.mapError((cause) =>
            ensureRuntimeError("inventory", "Failed to load OpenCode models.", cause),
          ),
        );

      const skillPage = yield* client.skill
        .list({ location })
        .pipe(
          Effect.mapError((cause) =>
            ensureRuntimeError("inventory", "Failed to load OpenCode skills.", cause),
          ),
        );

      return {
        models: modelPage.data.map((model) => ({
          id: model.id,
          providerId: model.providerID,
          name: model.name,
          variants: model.variants.map((variant) => variant.id),
        })),
        skills: skillPage.data.map((skill) => ({
          name: skill.name,
          description: skill.description ?? null,
          location: skill.location,
        })),
      } satisfies OpenCode2Inventory;
    });

  return OpenCode2Runtime.of({ connect, loadInventory });
});

export const OpenCode2RuntimeLive = Layer.effect(OpenCode2Runtime, makeOpenCode2Runtime).pipe(
  // `HttpClient` (API calls) and `FileSystem` (local service registration file)
  // both come from the Node platform layer.
  Layer.provide(NodeServices.layer),
);

export type { OpenCodeClient };

/**
 * Parse a `provider/model#variant` selection into a v2 `Model.Ref`. Returns
 * undefined for anything malformed; `Model.Ref.parse` throws on inputs the
 * separator check alone would let through (e.g. `openai/#`), so the try/catch
 * is load-bearing rather than defensive.
 */
export function parseOpenCode2ModelSlug(
  slug: string | null | undefined,
): ReturnType<typeof Model.Ref.parse> | undefined {
  if (typeof slug !== "string") {
    return undefined;
  }
  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return undefined;
  }
  try {
    return Model.Ref.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Service command used when T3 has to start the v2 background service itself.
 * The SDK default is `opencode serve --service`, but the v2 binary is
 * `opencode2` — on a machine with only v2 installed, going through the default
 * would spawn a v1 binary (or nothing) and the 2.x version gate could never
 * pass. Returns undefined so the caller can fall back to the SDK default.
 */
export function openCode2ServiceCommand(
  binaryPath: string | undefined,
): ReadonlyArray<string> | undefined {
  const command = binaryPath?.trim();
  return command && command.length > 0 ? [command, "serve", "--service"] : undefined;
}

/**
 * Fold a composer `variant` selection (the Reasoning option) into a parsed
 * model ref. v2's `session.prompt` has no variant field — the variant rides
 * inside the model ref as `provider/model#variant` — so it has to be attached
 * here. A variant that fails to parse yields the ref unchanged, so a bad
 * selection degrades to the provider default instead of dropping the model.
 */
export function withOpenCode2Variant(
  ref: ReturnType<typeof Model.Ref.parse> | undefined,
  variant: string | null | undefined,
): ReturnType<typeof Model.Ref.parse> | undefined {
  const trimmed = variant?.trim();
  if (!ref || !trimmed || trimmed.length === 0) {
    return ref;
  }
  return parseOpenCode2ModelSlug(`${ref.providerID}/${ref.id}#${trimmed}`) ?? ref;
}

/**
 * v2 file attachments. Gating mirrors the v1 adapter's native-file rules
 * (images, text, pdf under 20 MB) so providers without vision or large-file
 * support do not receive parts they cannot process.
 */
export function toOpenCode2FileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): ReadonlyArray<{
  readonly type: "file";
  readonly mime: string;
  readonly name: string;
  readonly url: string;
}> {
  const OPENCODE2_NATIVE_IMAGE_MIMES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ]);
  const OPENCODE2_NATIVE_FILE_PART_MAX_BYTES = 20 * 1024 * 1024;

  const parts: Array<{
    readonly type: "file";
    readonly mime: string;
    readonly name: string;
    readonly url: string;
  }> = [];
  for (const attachment of input.attachments ?? []) {
    if (
      attachment.type === "file" &&
      "source" in attachment &&
      attachment.source?._tag === "pasted-text"
    ) {
      continue;
    }
    const normalized = attachment.mimeType.trim().toLowerCase();
    const isNative =
      attachment.sizeBytes <= OPENCODE2_NATIVE_FILE_PART_MAX_BYTES &&
      (OPENCODE2_NATIVE_IMAGE_MIMES.has(normalized) ||
        normalized.startsWith("text/") ||
        normalized === "application/pdf");
    if (!isNative) continue;
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) continue;
    parts.push({
      type: "file",
      mime: attachment.mimeType,
      name: attachment.name,
      url: NodeURL.pathToFileURL(attachmentPath).href,
    });
  }
  return parts;
}
