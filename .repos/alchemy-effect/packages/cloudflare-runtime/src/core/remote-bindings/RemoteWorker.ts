import { loadInternalWorker } from "../internal/internal-worker.ts";
import type { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as NodeCrypto from "node:crypto";
const RemoteWorkerScript = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/remote-bindings/workers/remote.worker",
    ),
};
import type { ConfigError, SystemError } from "../RuntimeError.shared.ts";
import { ApiError } from "../RuntimeError.shared.ts";
import * as Access from "./Access.ts";
import type {
  RemoteWorkerConfig,
  RemoteWorkerResult,
} from "./RemoteWorkerConfig.shared.ts";

export class RemoteWorker extends Context.Service<
  RemoteWorker,
  {
    readonly deploy: (
      options: RemoteWorkerConfig,
    ) => Effect.Effect<
      RemoteWorkerResult,
      ApiError | ConfigError | SystemError
    >;
  }
>()("cloudflare-runtime/remote-bindings/RemoteWorker") {}

// Explicit annotation: the inferred type references `Credentials` from
// `@distilled.cloud/cloudflare`, which the dts bundler cannot name on its
// own — without this it degrades `make`/`layer` (and everything composed
// from them, e.g. `RuntimeServices.layerRuntime`) to `any, any`.
export const make: (
  accountId: Effect.Effect<string>,
) => Effect.Effect<
  RemoteWorker["Service"],
  never,
  Access.Access | Credentials | HttpClient.HttpClient
> = Effect.fn(function* (accountId: Effect.Effect<string>) {
  const http = yield* HttpClient.HttpClient;
  const access = yield* Access.Access;

  const createSubdomainEdgePreviewSession =
    yield* workers.createSubdomainEdgePreviewSession;
  const getSubdomain = yield* workers.getSubdomain;
  const createScriptEdgePreview = yield* workers.createScriptEdgePreview;

  const AccountSubdomain = yield* Effect.cached(
    sandboxApi(
      "PreviewSubdomain",
      `Failed to get the workers.dev subdomain for account ${accountId}.`,
      accountId.pipe(
        Effect.flatMap((accountId) => getSubdomain({ accountId })),
      ),
    ),
  );

  const createPreviewUploadToken = Effect.fn(function* () {
    const { token, exchangeUrl } = yield* sandboxApi(
      "PreviewSession",
      `Failed to create a preview session for account ${accountId}.`,
      createSubdomainEdgePreviewSession({ accountId: yield* accountId }),
    );
    if (!exchangeUrl) {
      return token;
    }
    // Intentional: if the exchange URL fails or returns an unexpected
    // shape we silently fall back to the original token. This mirrors
    // workers-sdk's behavior. We tap the cause into the debug log so it's
    // recoverable from logs without changing behavior.
    const json = yield* http.get(exchangeUrl).pipe(
      Effect.flatMap((response) => response.json),
      Effect.tapCause(Effect.logDebug),
      Effect.orElseSucceed(() => undefined),
    );
    if (
      typeof json === "object" &&
      json !== null &&
      "token" in json &&
      typeof json.token === "string"
    ) {
      return json.token;
    }
    return token;
  });

  const uploadPreviewScript = Effect.fn(function* (
    options: RemoteWorkerConfig,
    cfPreviewUploadConfigToken: string,
  ) {
    // Salt the main module with a hash of the session's CONFIG. The edge
    // preview dedupes deployments by script content and IGNORES changed
    // bindings metadata: re-uploading byte-identical files under the same
    // script name returns a preview token routed to the FIRST deployment
    // of those bytes — whose env carries a stale binding set (its resources
    // may no longer exist), so every proxied call 400s with our own
    // BindingNotFound. A deterministic config hash keeps caching intact for
    // an unchanged session while forcing a distinct deployment whenever the
    // binding set differs. Appended as a TRAILING comment so the module's
    // line numbers (stack traces) are untouched.
    const configSalt = yield* Effect.sync(() =>
      NodeCrypto.createHash("sha256")
        .update(JSON.stringify(options))
        .digest("hex"),
    );
    const files = yield* Effect.promise(RemoteWorkerScript.worker).pipe(
      Effect.map(({ modules }) =>
        Object.entries(modules).map(
          ([name, content], index) =>
            new File(
              index === 0
                ? [content, `\n// alchemy-remote-config:${configSalt}\n`]
                : [content],
              name,
              { type: "application/javascript+module" },
            ),
        ),
      ),
    );
    return yield* sandboxApi(
      "PreviewUpload",
      `Failed to upload the script preview for "${options.name}".`,
      createScriptEdgePreview({
        accountId: yield* accountId,
        scriptName: options.name,
        cfPreviewUploadConfigToken,
        wranglerSessionConfig: { workersDev: true, minimalMode: true },
        metadata: {
          compatibilityDate: "2025-04-28",
          bindings: options.bindings,
          mainModule: files[0].name,
        },
        files,
      }),
    );
  });

  return RemoteWorker.of({
    deploy: Effect.fn(function* (options) {
      const [{ previewToken }, { url, headers }] = yield* Effect.all(
        [
          createPreviewUploadToken().pipe(
            Effect.flatMap((cfPreviewUploadConfigToken) =>
              uploadPreviewScript(options, cfPreviewUploadConfigToken),
            ),
          ),
          AccountSubdomain.pipe(
            Effect.map(
              ({ subdomain }) => `${options.name}.${subdomain}.workers.dev`,
            ),
            Effect.flatMap(
              Effect.fn(function* (host) {
                const headers = yield* access.getAccessHeaders(host);
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
      };
    }),
  });
});

export const layer = (
  accountId: Effect.Effect<string>,
): Layer.Layer<
  RemoteWorker,
  never,
  Access.Access | Credentials | HttpClient.HttpClient
> => Layer.effect(RemoteWorker, make(accountId));

/**
 * Wrap a Cloudflare SDK call so that both typed failures and defects (the
 * SDK calls `Effect.die` on some validation errors) surface as a tagged
 * {@link ApiError} in the typed channel. This means downstream callers
 * only need to handle the union of `ApiError | AccessError`, not arbitrary
 * defects.
 */
const sandboxApi = <A, E, R>(
  subtag: string,
  message: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ApiError, R> =>
  effect.pipe(
    Effect.tapCause((cause) => Effect.logError(Cause.pretty(cause))),
    Effect.catchCause((cause) => {
      const failure = Cause.findErrorOption(cause);
      const defect = Cause.findDefect(cause);
      const original: unknown =
        failure._tag === "Some"
          ? failure.value
          : Result.isSuccess(defect)
            ? defect.success
            : cause;
      return Effect.fail(
        new ApiError({
          subtag,
          message,
          cause: original,
        }),
      );
    }),
    Effect.timeout(30_000),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new ApiError({
          subtag,
          message,
          hint: "The request timed out after 30 seconds.",
        }),
      ),
    ),
  );
