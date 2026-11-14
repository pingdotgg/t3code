import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

import type * as Undici from "undici";

// undici is external to the CLI bundle; Node single-executables can load it from disk only with require.
const requireUndici = NodeModule.createRequire(import.meta.url);

/** Node 26 bundles h2-capable undici 8; Node 22/24 and Electron stay on HTTP/1.1 with 6/7. */
export const builtinFetchUsesHttp2 = (bundledUndiciVersion: string | undefined) =>
  Number.parseInt(bundledUndiciVersion ?? "", 10) >= 8;

const PROXY_ENV_NAMES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

/**
 * Whether outbound fetch should use the proxy the environment names. Node wires
 * that up only under NODE_USE_ENV_PROXY; an explicit value for it, on or off, is
 * the user's call and wins over this default.
 */
export const shouldUseEnvProxy = (env: NodeJS.ProcessEnv): boolean =>
  env.NODE_USE_ENV_PROXY === undefined &&
  PROXY_ENV_NAMES.some((name) => (env[name]?.trim() ?? "") !== "");

/**
 * Preserves the EnvHttpProxyAgent installed by --use-env-proxy / NODE_USE_ENV_PROXY,
 * and installs one when the environment names a proxy Node would otherwise ignore.
 */
export function installHttp1FetchDispatcher(env: NodeJS.ProcessEnv = process.env): void {
  const undici = requireUndici("undici") as typeof Undici;
  // Node's agent comes from its internal undici copy, so `instanceof` against the npm class is false.
  const nodeUsesEnvProxy = undici.getGlobalDispatcher().constructor.name === "EnvHttpProxyAgent";
  const autoEnvProxy = !nodeUsesEnvProxy && shouldUseEnvProxy(env);
  undici.setGlobalDispatcher(
    nodeUsesEnvProxy || autoEnvProxy
      ? new undici.EnvHttpProxyAgent({
          allowH2: false,
          // A proxy the user never opted Node into must not swallow local server and preview probes.
          ...(autoEnvProxy && {
            noProxy: env.no_proxy ?? env.NO_PROXY ?? "localhost,127.0.0.1,::1",
          }),
          // ProxyAgent's connector forces h2 and ignores allowH2; replace it for HTTPS proxies.
          clientFactory: (origin) => new undici.Pool(origin, { allowH2: false }),
        })
      : new undici.Agent({ allowH2: false }),
  );
}

/**
 * Avoids uncaught idle-timeout errors on h2 streams (https://github.com/nodejs/undici/issues/5936),
 * and routes fetch through an environment proxy on any Node version.
 */
export function keepOutboundFetchOnHttp1(env: NodeJS.ProcessEnv = process.env): void {
  if (builtinFetchUsesHttp2(process.versions.undici) || shouldUseEnvProxy(env)) {
    installHttp1FetchDispatcher(env);
  }
}

// @types/node does not declare setTypeOfService yet.
type TypeOfServiceSocket = {
  setTypeOfService?: (this: NodeNet.Socket, typeOfService: number) => NodeNet.Socket;
};

// Bundled undici calls this from a socket callback without catching. On macOS,
// EINVAL after a peer reset must not exit the server over an optional QoS hint.
export function ignoreMacosTypeOfServiceEinval(
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Runs before ACP dispatch without loading the Effect graph.
  platform = process.platform,
  socketPrototype: TypeOfServiceSocket = NodeNet.Socket.prototype as TypeOfServiceSocket,
): void {
  if (platform !== "darwin") return;
  const setTypeOfService = socketPrototype.setTypeOfService;
  if (typeof setTypeOfService !== "function") return;
  socketPrototype.setTypeOfService = function (...args) {
    try {
      return setTypeOfService.apply(this, args);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EINVAL") return this;
      throw error;
    }
  };
}

/**
 * Node's 250 ms Happy Eyeballs attempt timeout abandons a working-but-slow IPv4
 * connect when IPv6 is advertised but unroutable, which broke the ACP registry
 * fetch. A larger `--network-family-autoselection-attempt-timeout` still wins.
 */
export function extendConnectionAttemptTimeout(): void {
  NodeNet.setDefaultAutoSelectFamilyAttemptTimeout(
    Math.max(NodeNet.getDefaultAutoSelectFamilyAttemptTimeout(), 1_000),
  );
}
