import * as Schedule from "effect/Schedule";
import * as Exit from "effect/Exit";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { BoatApiError } from "./errors.ts";
import {
  BoatActionResponse,
  BoatDeletionOperationResponse,
  BoatSavedSnapshotResponse,
  BoatUsage,
  BoatCommandResult,
  type BoatSavedSnapshot,
  type BoatDeletionOperation,
  type BoatForkInput,
  BoatBrowserResponse,
  BoatDesktopResponse,
  BoatDetailsResponse,
  BoatListResponse,
  ExposedPortResponse,
  SshKeyResponse,
  mapBoatSandbox,
  type BoatSandboxDetails,
  type BoatSandboxSummary,
  type CreateSandboxInput,
  type DesktopUrlInput,
  type BoatDesktopStreamSession,
} from "./schemas.ts";

const DEFAULT_BOAT_API_BASE_URL = "https://boat.dev/api/v1";
export interface BoatApiClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly httpClient?: HttpClient.HttpClient;
  readonly maxArtifactBytes?: number;
}
export interface BoatApiClient {
  readonly listSandboxes: () => Effect.Effect<readonly BoatSandboxSummary[], BoatApiError>;
  readonly getSandbox: (id: string) => Effect.Effect<BoatSandboxDetails, BoatApiError>;
  readonly createSandbox: (
    input: CreateSandboxInput,
  ) => Effect.Effect<BoatSandboxDetails, BoatApiError>;
  readonly resumeSandbox: (
    id: string,
    size?: CreateSandboxInput["size"],
  ) => Effect.Effect<BoatSandboxDetails, BoatApiError>;
  readonly stopSandbox: (id: string) => Effect.Effect<BoatSandboxDetails, BoatApiError>;
  readonly forkSandbox: (
    id: string,
    input?: BoatForkInput,
  ) => Effect.Effect<BoatSandboxDetails, BoatApiError>;
  readonly beginDeleteSandbox: (id: string) => Effect.Effect<BoatDeletionOperation, BoatApiError>;
  readonly getDeletionOperation: (id: string) => Effect.Effect<BoatDeletionOperation, BoatApiError>;
  readonly waitDeletion: (id: string) => Effect.Effect<BoatDeletionOperation, BoatApiError>;
  readonly deleteSandbox: (id: string) => Effect.Effect<void, BoatApiError>;
  readonly captureSnapshot: (input: {
    readonly sandboxId: string;
    readonly name: string;
  }) => Effect.Effect<BoatSavedSnapshot, BoatApiError>;
  readonly getSnapshot: (name: string) => Effect.Effect<BoatSavedSnapshot, BoatApiError>;
  readonly deleteSnapshot: (name: string) => Effect.Effect<void, BoatApiError>;
  readonly getUsage: (id: string) => Effect.Effect<BoatUsage, BoatApiError>;
  readonly runCommand: (
    id: string,
    command: string,
  ) => Effect.Effect<BoatCommandResult, BoatApiError>;
  readonly getArtifact: (id: string, path: string) => Effect.Effect<Uint8Array, BoatApiError>;
  readonly addSshKey: (
    id: string,
    publicKey: string,
  ) => Effect.Effect<SshKeyResponse, BoatApiError>;
  readonly getDesktopUrl: (
    id: string,
    options?: DesktopUrlInput,
  ) => Effect.Effect<BoatDesktopStreamSession, BoatApiError>;
  readonly extendAutoStop: (
    id: string,
    hours: number,
  ) => Effect.Effect<BoatSandboxDetails, BoatApiError>;
  readonly exposePort: (
    id: string,
    port: number,
    isPublic?: boolean,
  ) => Effect.Effect<ExposedPortResponse, BoatApiError>;
}
const decodeDeletion = Schema.decodeUnknownEffect(BoatDeletionOperationResponse);
const decodeSnapshot = Schema.decodeUnknownEffect(BoatSavedSnapshotResponse);
const decodeUsage = Schema.decodeUnknownEffect(BoatUsage);
const decodeCommand = Schema.decodeUnknownEffect(BoatCommandResult);
const decodeList = Schema.decodeUnknownEffect(BoatListResponse);
const decodeDetails = Schema.decodeUnknownEffect(BoatDetailsResponse);
const decodeAction = Schema.decodeUnknownEffect(BoatActionResponse);
const decodeBrowser = Schema.decodeUnknownEffect(BoatBrowserResponse);
const decodeDesktop = Schema.decodeUnknownEffect(BoatDesktopResponse);
const decodeSshKey = Schema.decodeUnknownEffect(SshKeyResponse);
const decodePort = Schema.decodeUnknownEffect(ExposedPortResponse);
const isBoatApiError = Schema.is(BoatApiError);

/**
 * Provider limit semantics (from the documented formats):
 * - `rate_limited` — window pacing; the body names the window (minute/hour/day).
 * - `limit_reached` — an organization-concurrent cap; a different condition than pacing.
 * The documented `Retry-After` header (IP-level) wins over any body-derived wait.
 */
const parseRateLimit = (
  body: unknown,
  headers?: { readonly window?: string; readonly retryAfterSeconds?: number },
): BoatApiError["rateLimit"] | undefined => {
  if (body === undefined || body === null || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const window =
    record.window === "minute" || record.window === "hour" || record.window === "day"
      ? record.window
      : undefined;
  const scope =
    record.code === "limit_reached" ? ("capped" as const) : window ? ("paced" as const) : undefined;
  if (!scope) return undefined;
  return {
    scope,
    ...(window ? { window } : {}),
    ...(headers?.retryAfterSeconds !== undefined
      ? { waitMs: Math.round(headers.retryAfterSeconds * 1000) }
      : {}),
  };
};
const invalidResponse = (detail: unknown) =>
  new BoatApiError({
    status: 502,
    reason: "Boat API returned an invalid response format.",
    detail,
  });

export function createBoatApiClient(options: BoatApiClientOptions): BoatApiClient {
  const maxArtifactBytes = options.maxArtifactBytes ?? 128 * 1024 * 1024;
  const baseUrl = (options.baseUrl ?? DEFAULT_BOAT_API_BASE_URL).replace(/\/+$/, "");
  const clientLayer = options.httpClient
    ? Layer.succeed(HttpClient.HttpClient, options.httpClient)
    : FetchHttpClient.layer;
  const request = Effect.fn("BoatApiClient.request")(function* (
    req: HttpClientRequest.HttpClientRequest,
  ) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        req.pipe(HttpClientRequest.bearerToken(options.apiKey), HttpClientRequest.acceptJson),
      )
      .pipe(
        Effect.mapError(
          (detail) =>
            new BoatApiError({
              status: 0,
              reason: "Unable to connect to Boat.dev. Please check your internet connection.",
              detail,
            }),
        ),
      );
    if (response.status >= 400) {
      const rateLimit =
        response.status === 429
          ? parseRateLimit(yield* response.json.pipe(Effect.orElseSucceed(() => undefined)))
          : undefined;
      return yield* new BoatApiError({
        status: response.status,
        reason:
          response.status === 401
            ? "Invalid Boat API key. Please check your credentials."
            : response.status === 403
              ? "Boat API key lacks permission. Check its scope and organization."
              : response.status === 429
                ? "Boat API rate limit exceeded. Please try again later."
                : "Boat API request failed.",
        ...(rateLimit ? { rateLimit } : {}),
      });
    }
    if (response.status === 204) return null;
    return yield* response.json.pipe(Effect.mapError(invalidResponse));
  }, Effect.provide(clientLayer));
  const sandboxPath = (id: string) => `${baseUrl}/sandboxes/${encodeURIComponent(id)}`;
  const getSandbox: BoatApiClient["getSandbox"] = Effect.fn("BoatApiClient.getSandbox")(
    function* (id) {
      const json = yield* request(HttpClientRequest.get(sandboxPath(id)));
      const result = yield* decodeDetails(json).pipe(Effect.mapError(invalidResponse));
      return mapBoatSandbox(result.sandbox);
    },
  );
  const update = Effect.fn("BoatApiClient.update")(function* (
    id: string,
    body: { readonly name?: string; readonly ttlSeconds?: number },
  ) {
    const json = yield* request(
      HttpClientRequest.patch(sandboxPath(id)).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
    );
    const result = yield* decodeDetails(json).pipe(Effect.mapError(invalidResponse));
    return mapBoatSandbox(result.sandbox);
  });
  const finishAllocation = Effect.fn("BoatApiClient.finishAllocation")(function* (
    id: string,
    name?: string,
  ) {
    return yield* (name ? update(id, { name }) : getSandbox(id)).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? request(HttpClientRequest.post(`${sandboxPath(id)}/stop`)).pipe(Effect.ignore)
          : Effect.void,
      ),
      Effect.mapError((error) => new BoatApiError({ ...error, sandboxId: id })),
    );
  });
  const beginDeleteSandbox = Effect.fn("BoatApiClient.beginDeleteSandbox")(function* (id: string) {
    const accepted = yield* request(
      HttpClientRequest.make("DELETE")(sandboxPath(id)).pipe(
        HttpClientRequest.setHeader("X-Ascii-Confirm-Delete", id),
      ),
    ).pipe(Effect.flatMap((json) => decodeDeletion(json).pipe(Effect.mapError(invalidResponse))));
    if (accepted.operation.targetId !== id || accepted.operation.kind !== "sandbox")
      return yield* invalidResponse(new Error("Deletion operation targets a different resource."));
    return accepted.operation;
  });
  const getDeletionOperation = Effect.fn("BoatApiClient.getDeletionOperation")(function* (
    id: string,
  ) {
    const result = yield* request(
      HttpClientRequest.get(`${baseUrl}/deletion-operations/${encodeURIComponent(id)}`),
    ).pipe(Effect.flatMap((json) => decodeDeletion(json).pipe(Effect.mapError(invalidResponse))));
    if (result.operation.id !== id)
      return yield* invalidResponse(new Error("Deletion operation identity changed."));
    return result.operation;
  });
  const waitDeletion = Effect.fn("BoatApiClient.waitDeletion")(function* (id: string) {
    return yield* getDeletionOperation(id).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        while: (operation) => operation.status !== "completed" && operation.status !== "blocked",
      }),
      Effect.filterOrFail(
        (operation) => operation.status !== "blocked",
        () =>
          new BoatApiError({ status: 409, reason: "Boat deletion is blocked and needs retry." }),
      ),
      Effect.timeout("10 minutes"),
      Effect.catchTags({
        TimeoutError: (detail) =>
          Effect.fail(
            new BoatApiError({ status: 408, reason: "Boat deletion is still pending.", detail }),
          ),
      }),
    );
  });
  return {
    listSandboxes: Effect.fn("BoatApiClient.listSandboxes")(function* () {
      const sandboxes: BoatSandboxSummary[] = [];
      let cursor: string | null = null;
      do {
        const url = new URL(`${baseUrl}/sandboxes`);
        url.searchParams.set("limit", "200");
        if (cursor !== null) url.searchParams.set("cursor", cursor);
        const json = yield* request(HttpClientRequest.get(url.toString()));
        const result = yield* decodeList(json).pipe(Effect.mapError(invalidResponse));
        sandboxes.push(...result.sandboxes.map(mapBoatSandbox));
        cursor = result.nextCursor ?? null;
      } while (cursor !== null);
      return sandboxes;
    }),
    getSandbox,
    createSandbox: Effect.fn("BoatApiClient.createSandbox")(function* (input) {
      const json = yield* request(
        HttpClientRequest.post(`${baseUrl}/sandboxes`).pipe(
          (request) =>
            input.requestId
              ? HttpClientRequest.setHeader(request, "Idempotency-Key", input.requestId)
              : request,
          HttpClientRequest.bodyJsonUnsafe({
            type: input.size ?? "default",
            ttlSeconds: Math.max(1, Math.round((input.autoStopMinutes ?? 60) * 60)),
            ...(input.template ? { from: input.template } : {}),
          }),
        ),
      );
      const result = yield* decodeDetails(json).pipe(Effect.mapError(invalidResponse));
      return yield* finishAllocation(result.sandbox.id, input.name);
    }),
    resumeSandbox: Effect.fn("BoatApiClient.resumeSandbox")(function* (id, size) {
      yield* request(
        HttpClientRequest.post(`${sandboxPath(id)}/resume`).pipe(
          HttpClientRequest.bodyJsonUnsafe(size ? { type: size } : {}),
        ),
      );
      return yield* getSandbox(id);
    }),
    stopSandbox: Effect.fn("BoatApiClient.stopSandbox")(function* (id) {
      yield* request(HttpClientRequest.post(`${sandboxPath(id)}/stop`));
      return yield* getSandbox(id);
    }),
    forkSandbox: Effect.fn("BoatApiClient.forkSandbox")(function* (id, input) {
      const json = yield* request(
        HttpClientRequest.post(`${sandboxPath(id)}/fork`).pipe(
          (request) =>
            input?.requestId
              ? HttpClientRequest.setHeader(request, "Idempotency-Key", input.requestId)
              : request,
          HttpClientRequest.bodyJsonUnsafe({
            ...(input?.size ? { type: input.size } : {}),
            ...(input?.autoStopMinutes === undefined
              ? {}
              : { ttlSeconds: Math.max(1, Math.round(input.autoStopMinutes * 60)) }),
          }),
        ),
      );
      const result = yield* decodeAction(json).pipe(Effect.mapError(invalidResponse));
      return yield* finishAllocation(result.id, input?.name);
    }),
    beginDeleteSandbox,
    getDeletionOperation,
    waitDeletion,
    deleteSandbox: Effect.fn("BoatApiClient.deleteSandbox")(function* (id) {
      const operation = yield* beginDeleteSandbox(id);
      if (operation.status !== "completed") yield* waitDeletion(operation.id);
    }),
    captureSnapshot: Effect.fn("BoatApiClient.captureSnapshot")(function* (input) {
      const result = yield* request(
        HttpClientRequest.post(`${baseUrl}/saved-snapshots`).pipe(
          HttpClientRequest.bodyJsonUnsafe(input),
        ),
      ).pipe(Effect.flatMap((json) => decodeSnapshot(json).pipe(Effect.mapError(invalidResponse))));
      if (
        result.snapshot.name !== input.name ||
        result.snapshot.sourceSandboxId !== input.sandboxId
      )
        return yield* invalidResponse(new Error("Fresh snapshot identity changed."));
      return result.snapshot;
    }),
    getSnapshot: Effect.fn("BoatApiClient.getSnapshot")(function* (name) {
      const result = yield* request(
        HttpClientRequest.get(`${baseUrl}/saved-snapshots/${encodeURIComponent(name)}`),
      ).pipe(Effect.flatMap((json) => decodeSnapshot(json).pipe(Effect.mapError(invalidResponse))));
      if (result.snapshot.name !== name)
        return yield* invalidResponse(new Error("Saved snapshot identity changed."));
      return result.snapshot;
    }),
    deleteSnapshot: Effect.fn("BoatApiClient.deleteSnapshot")(function* (name) {
      yield* request(
        HttpClientRequest.make("DELETE")(`${baseUrl}/saved-snapshots/${encodeURIComponent(name)}`),
      );
    }),
    getUsage: Effect.fn("BoatApiClient.getUsage")(function* (id) {
      const usage = yield* request(HttpClientRequest.get(`${sandboxPath(id)}/usage`)).pipe(
        Effect.flatMap((json) => decodeUsage(json).pipe(Effect.mapError(invalidResponse))),
      );
      if (usage.sandboxId !== id)
        return yield* invalidResponse(new Error("Usage response targets a different sandbox."));
      return usage;
    }),
    runCommand: Effect.fn("BoatApiClient.runCommand")(function* (id, command) {
      return yield* request(
        HttpClientRequest.post(`${sandboxPath(id)}/commands`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ command, timeoutSeconds: 60 }),
        ),
      ).pipe(Effect.flatMap((json) => decodeCommand(json).pipe(Effect.mapError(invalidResponse))));
    }),
    getArtifact: Effect.fn("BoatApiClient.getArtifact")(function* (id, path) {
      const url = new URL(`${sandboxPath(id)}/artifacts`);
      url.searchParams.set("path", path);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client
        .execute(
          HttpClientRequest.get(url.toString()).pipe(HttpClientRequest.bearerToken(options.apiKey)),
        )
        .pipe(Effect.mapError(invalidResponse));
      if (response.status !== 200)
        return yield* new BoatApiError({
          status: response.status,
          reason: "Could not download Boat recording.",
        });
      const chunks: Uint8Array[] = [];
      let size = 0;
      yield* response.stream.pipe(
        Stream.runForEach((chunk) => {
          size += chunk.byteLength;
          if (size > maxArtifactBytes)
            return Effect.fail(
              new BoatApiError({
                status: 413,
                reason: "Boat recording exceeds the download size limit.",
              }),
            );
          chunks.push(chunk);
          return Effect.void;
        }),
        Effect.mapError((cause) => (isBoatApiError(cause) ? cause : invalidResponse(cause))),
      );
      if (size === 0)
        return yield* new BoatApiError({
          status: 502,
          reason: "Boat recording download was empty.",
        });
      const result = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    }, Effect.provide(clientLayer)),
    addSshKey: Effect.fn("BoatApiClient.addSshKey")(function* (id, publicKey) {
      const json = yield* request(
        HttpClientRequest.post(`${sandboxPath(id)}/sshkey`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ key: publicKey }),
        ),
      );
      return yield* decodeSshKey(json).pipe(Effect.mapError(invalidResponse));
    }),
    getDesktopUrl: Effect.fn("BoatApiClient.getDesktopUrl")(function* (id, desktopOptions) {
      const url = new URL(
        `${sandboxPath(id)}/${desktopOptions?.viewMode === "browser" ? "browser" : "desktop"}`,
      );
      if (desktopOptions?.theme) url.searchParams.set("theme", desktopOptions.theme);
      const json = yield* request(
        HttpClientRequest.post(url.toString()).pipe(HttpClientRequest.bodyJsonUnsafe({})),
      );
      const desktopUrl =
        desktopOptions?.viewMode === "browser"
          ? (yield* decodeBrowser(json).pipe(Effect.mapError(invalidResponse))).browserUrl
          : (yield* decodeDesktop(json).pipe(Effect.mapError(invalidResponse))).desktopUrl;
      return {
        desktopUrl,
        expiresAt: null,
        viewMode: desktopOptions?.viewMode ?? "desktop",
      };
    }),
    extendAutoStop: (id, hours) =>
      update(id, {
        ttlSeconds: Math.max(
          1,
          Math.round((Number.isFinite(hours) && hours > 0 ? hours : 1) * 3600),
        ),
      }),
    exposePort: Effect.fn("BoatApiClient.exposePort")(function* (id, port, isPublic = false) {
      const json = yield* request(
        HttpClientRequest.post(`${sandboxPath(id)}/host`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ port, public: isPublic, localhost: true }),
        ),
      );
      return yield* decodePort(json).pipe(Effect.mapError(invalidResponse));
    }),
  };
}
