/**
 * Direct service binding from the entry middleware to the raw user worker
 * (`SERVICE_USER_WORKER`), bypassing any downstream fetch middlewares
 * (`images:delivery`, `stream:router`, ...).
 *
 * The entry's `USER_WORKER` upstream binding points at the *next middleware
 * in the chain*, and middlewares are fetch-only HTTP-path interceptors — a
 * JSRPC call like `.email(...)` against one fails with "The RPC receiver
 * does not implement the method". Non-fetch event dispatch (`queue()`,
 * `scheduled()`, `email()`) therefore goes through this direct binding,
 * mirroring Miniflare's RPCProxyWorker model where only `fetch` traverses
 * the router chain and every other RPC method forwards straight to the user
 * worker (`workers-sdk/packages/miniflare/src/workers/assets/rpc-proxy.worker.ts`).
 */
export const BINDING_USER_WORKER_DIRECT = "USER_WORKER_DIRECT";

/** Internal module-runner connection; routed directly to the Worker in dev. */
export const PATH_MODULE_RUNNER_INIT = "/cdn-cgi/alchemy/module-runner/init";

/**
 * Header the entry worker sets with the Worker's simulated Cloudflare Access
 * blob (`{ app_aud, jwt_claims }`), from which workerd populates
 * `ctx.access`. A client-supplied one is always dropped (Miniflare's
 * `MF-Access-Blob`).
 */
export const HEADER_ACCESS_BLOB = "MF-Access-Blob";

/** The entry worker's access blob, when the Worker simulates Access. */
export const BINDING_ACCESS_BLOB = "ACCESS_BLOB";
