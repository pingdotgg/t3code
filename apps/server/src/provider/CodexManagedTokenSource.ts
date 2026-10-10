// @effect-diagnostics nodeBuiltinImport:off - scope-owned loopback bridge for Codex's credential command.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

// Codex invokes this command again when its cached bearer expires or receives a 401.
// The child receives a bridge credential, never a fixed copy of the provider token.
export const managedCodexTokenCommand = `
fetch(process.env.T3CODE_MANAGED_CODEX_AUTH_URL, {
  headers: { Authorization: "Bearer " + process.env.T3CODE_MANAGED_CODEX_AUTH_SECRET,
    "X-T3-Codex-Account": process.env.T3CODE_MANAGED_CODEX_AUTH_ACCOUNT },
}).then(async response => {
  if (!response.ok) throw new Error();
  process.stdout.write(await response.text());
}).catch(() => {
  process.stderr.write("Could not renew managed Codex credentials.\\n");
  process.exitCode = 1;
});
`;

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
  const server = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<NodeHttp.Server>((resolve, reject) => {
          const server = NodeHttp.createServer((request, response) => {
            if (request.method !== "GET" || request.url !== "/token") {
              response.writeHead(404).end();
              return;
            }
            if (request.headers.authorization !== `Bearer ${secret}`) {
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
