import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Access } from "./Access.ts";
import { CloudflareEnvironment } from "./CloudflareEnvironment.ts";

/**
 * A "remote binding" as understood by the Cloudflare Workers
 * edge-preview API. We reuse the distilled request schema so the
 * shape tracks Cloudflare's surface.
 */
type EdgeMetadata = NonNullable<
  NonNullable<workers.CreateScriptEdgePreviewRequest["metadata"]>
>;
export type EdgeBinding = NonNullable<
  NonNullable<EdgeMetadata["bindings"]>
>[number];

export class EdgeSessionError extends Data.TaggedError("EdgeSessionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface EdgeSessionOptions {
  /**
   * Name used as the preview script identifier on Cloudflare's side.
   * Shows up as the hostname: `{scriptName}.{subdomain}.workers.dev`.
   */
  readonly scriptName: string;
  /** ES-module worker script(s). The first file is the entrypoint. */
  readonly files: ReadonlyArray<File>;
  /** Remote bindings attached to the preview worker. */
  readonly bindings: ReadonlyArray<EdgeBinding>;
  /** @default "2025-04-28" */
  readonly compatibilityDate?: string;
}

/**
 * Information needed to call a running edge-preview worker. Attach
 * `headers` (including the `cf-workers-preview-token`) and fetch
 * `url` or a path under it.
 */
export interface EdgeSessionHandle {
  readonly url: string;
  readonly headers: Record<string, string>;
}

const DEFAULT_COMPATIBILITY_DATE = "2025-04-28";

const wrap = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) =>
  effect.pipe(
    Effect.mapError((cause) => new EdgeSessionError({ message, cause })),
  );

/**
 * Ask Cloudflare for a preview upload token. Some accounts return an
 * `exchangeUrl` that must be GET'd to swap the session token for a
 * short-lived upload token; when present we do the swap, falling back
 * to the original if the exchange fails.
 */
const createUploadToken = Effect.gen(function* () {
  const env = yield* CloudflareEnvironment;
  const http = yield* HttpClient.HttpClient;
  const createSubdomainEdgePreviewSession =
    yield* workers.createSubdomainEdgePreviewSession;
  const { token, exchangeUrl } = yield* createSubdomainEdgePreviewSession({
    accountId: env.accountId,
  });
  if (!exchangeUrl) return token;
  const json = yield* http.get(exchangeUrl).pipe(
    Effect.flatMap((r) => r.json),
    Effect.timeout(30_000),
    Effect.catch(() => Effect.succeed(null as unknown)),
  );
  if (
    typeof json === "object" &&
    json !== null &&
    "token" in json &&
    typeof (json as Record<string, unknown>).token === "string"
  ) {
    return (json as { token: string }).token;
  }
  return token;
});

const uploadScript = (options: EdgeSessionOptions, uploadToken: string) =>
  Effect.gen(function* () {
    const env = yield* CloudflareEnvironment;
    const createScriptEdgePreview = yield* workers.createScriptEdgePreview;
    return yield* createScriptEdgePreview({
      accountId: env.accountId,
      scriptName: options.scriptName,
      cfPreviewUploadConfigToken: uploadToken,
      wranglerSessionConfig: { workersDev: true, minimalMode: true },
      metadata: {
        compatibilityDate:
          options.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
        bindings: options.bindings as EdgeMetadata["bindings"],
        mainModule: options.files[0]!.name,
      },
      // Distilled's generated schema expects a mutable array; our
      // public surface keeps `readonly` so callers can pass a frozen
      // tuple without a cast on their side.
      files: options.files.slice(),
    }).pipe(Effect.timeout(30_000));
  });

const workerHost = (scriptName: string) =>
  Effect.gen(function* () {
    const env = yield* CloudflareEnvironment;
    const getSubdomain = yield* workers.getSubdomain;
    const { subdomain } = yield* getSubdomain({ accountId: env.accountId });
    return `${scriptName}.${subdomain}.workers.dev`;
  });

/**
 * Upload a short-lived preview worker to Cloudflare's edge and
 * return its URL plus the headers needed to reach it.
 *
 * Preview workers are ephemeral: they live only while a client keeps
 * sending requests with the returned preview token and expire soon
 * after. Nothing is deployed or billed.
 */
export const createEdgeSession = (
  options: EdgeSessionOptions,
): Effect.Effect<
  EdgeSessionHandle,
  EdgeSessionError,
  CloudflareEnvironment | HttpClient.HttpClient | Credentials | Access
> =>
  Effect.gen(function* () {
    const [{ previewToken }, { url, headers }] = yield* Effect.all(
      [
        createUploadToken.pipe(Effect.flatMap((t) => uploadScript(options, t))),
        workerHost(options.scriptName).pipe(
          Effect.flatMap(
            Effect.fn(function* (host) {
              const headers = yield* Access.use((access) =>
                access.getAccessHeaders(host),
              );
              return { url: `https://${host}`, headers };
            }),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );
    return {
      url,
      headers: { ...headers, "cf-workers-preview-token": previewToken },
    } satisfies EdgeSessionHandle;
  }).pipe((e) => wrap(e, "Failed to create edge preview session"));
