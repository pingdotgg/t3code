import { makeRandom } from "../Random.ts";

/** Env var on the RPC host. Callers send it as {@link RPC_TOKEN_HEADER}. */
export const RPC_TOKEN_ENV = "ALCHEMY_RPC_TOKEN";

/** Request header the caller must send. Never accepted from the public edge. */
export const RPC_TOKEN_HEADER = "x-alchemy-rpc-token";

export const PRIVATE_HOST_SUFFIX = ".railway.internal";

export const DEFAULT_RPC_PORT = 3000;

/** Same prefix as `alchemy/Rpc` so Function canvas code does not import Rpc.ts. */
export const RPC_PATH_PREFIX = "/__rpc__/";

/** Same envelope tag as `alchemy/Rpc.ErrorTag`. */
export const RPC_ERROR_TAG = "~alchemy/rpc/error";

export const RPC_TOKEN_ATTR = "rpcToken";

const envKey = (logicalId: string, suffix: string) =>
  `RAILWAY_RPC_${logicalId.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_${suffix}`;

export const rpcEnvKeys = (logicalId: string) => ({
  host: envKey(logicalId, "HOST"),
  port: envKey(logicalId, "PORT"),
  token: envKey(logicalId, "TOKEN"),
});

/**
 * Child {@link makeRandom} for a Function/Service logical id. Generated
 * once, persisted in alchemy state, reused on later deploys.
 */
export const mintRpcToken = (logicalId: string) =>
  makeRandom(`${logicalId}RpcToken`);
