// @effect-diagnostics nodeBuiltinImport:off - scope-owned loopback bridge for Codex's credential command.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export const makeCodexManagedTokenSource = Effect.fn("makeCodexManagedTokenSource")(function* (
  instanceId: ProviderInstanceId,
  access: Effect.Effect<
    { readonly accessToken: string; readonly clientId: string },
    ProviderSetupError
  >,
) {
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const secret = NodeCrypto.randomBytes(32).toString("base64url");
  const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest();
  const expectedAuthorization = digest(`Bearer ${secret}`);
  const server = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<NodeHttp.Server>((resolve, reject) => {
          const server = NodeHttp.createServer((request, response) => {
            if (request.method !== "GET" || request.url !== "/token") {
              response.writeHead(404).end();
              return;
            }
            // Fixed-length digests keep the comparison constant-time for any header length.
            if (
              !NodeCrypto.timingSafeEqual(
                digest(request.headers.authorization ?? ""),
                expectedAuthorization,
              )
            ) {
              response.writeHead(401).end();
              return;
            }
            const abort = new AbortController();
            response.once("close", () => abort.abort());
            void runPromise(access, { signal: abort.signal }).then(
              (credentials) => {
                if (response.destroyed) return;
                if (request.headers["x-t3-codex-account"] !== credentials.clientId) {
                  response.writeHead(409).end();
                  return;
                }
                if (!response.destroyed)
                  response
                    .writeHead(200, {
                      "content-type": "text/plain",
                      "cache-control": "no-store",
                    })
                    .end(credentials.accessToken);
              },
              () => {
                if (!response.destroyed) response.writeHead(503).end();
              },
            );
          });
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
      catch: () =>
        new ProviderSetupError({
          instanceId,
          operation: "runtime",
          detail: "Could not start the managed Codex credential bridge.",
        }),
    }),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    return yield* new ProviderSetupError({
      instanceId,
      operation: "runtime",
      detail: "Could not resolve the managed Codex credential bridge.",
    });
  return { url: `http://127.0.0.1:${address.port}/token`, secret };
});
