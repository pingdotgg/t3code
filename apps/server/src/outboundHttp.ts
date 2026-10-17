import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Undici from "undici";

// undici stays external to the CLI bundle (scripts/lib/cli-external-packages.ts).
// Inside a Node single-executable only `require` can load it from disk.
const requireUndici = NodeModule.createRequire(import.meta.url);

/**
 * Node 26 bundles undici 8, which offers h2 over ALPN to every HTTPS origin.
 * Node 22/24 (and Electron) bundle undici 6/7, whose fetch stays on HTTP/1.1.
 */
export const builtinFetchUsesHttp2 = (bundledUndiciVersion: string | undefined) =>
  Number.parseInt(bundledUndiciVersion ?? "", 10) >= 8;

/**
 * Node's `--use-env-proxy` / `NODE_USE_ENV_PROXY` installs an
 * `EnvHttpProxyAgent` at startup; that choice is kept so proxies still apply.
 */
export function installHttp1FetchDispatcher(): void {
  const undici = requireUndici("undici") as typeof Undici;
  // Node's agent comes from its internal undici copy, so `instanceof` against the npm class is false.
  const usesEnvProxy = undici.getGlobalDispatcher().constructor.name === "EnvHttpProxyAgent";
  undici.setGlobalDispatcher(
    usesEnvProxy
      ? new undici.EnvHttpProxyAgent({
          allowH2: false,
          // The connection to an HTTPS proxy is built here, not from `allowH2`. ProxyAgent's
          // `connect` option is dropped on purpose: its connector has h2 fixed on.
          clientFactory: (origin) => new undici.Pool(origin, { allowH2: false }),
        })
      : new undici.Agent({ allowH2: false }),
  );
}

/**
 * An undici HTTP/2 session that hits its idle timeout can emit `'error'` on a
 * stream with no listener, which Node turns into an uncaught exception that
 * exits the server (https://github.com/nodejs/undici/issues/5936).
 */
export function keepOutboundFetchOnHttp1(): void {
  if (builtinFetchUsesHttp2(process.versions.undici)) installHttp1FetchDispatcher();
}

// @types/node does not declare setTypeOfService yet.
type TypeOfServiceSocket = {
  setTypeOfService?: (this: NodeNet.Socket, typeOfService: number) => NodeNet.Socket;
};

/**
 * The undici 7 that Node 24 and Electron bundle calls `setTypeOfService()` on
 * every HTTP/1.1 request, from a socket callback, without catching. macOS
 * rejects it with EINVAL once the peer has reset the connection, so one request
 * to a listener that resets exits the server. The request still fails on its
 * own. undici 8.8 ignores these errors (https://github.com/nodejs/undici/pull/5547).
 */
export function ignoreMacosTypeOfServiceEinval(
  platform = HostProcess.Platform.defaultValue(),
  socketPrototype: TypeOfServiceSocket = NodeNet.Socket.prototype as NodeNet.Socket &
    TypeOfServiceSocket,
): void {
  const setTypeOfService = socketPrototype.setTypeOfService;
  if (platform !== "darwin" || typeof setTypeOfService !== "function") return;
  socketPrototype.setTypeOfService = function (typeOfService) {
    try {
      return setTypeOfService.call(this, typeOfService);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EINVAL") return this;
      throw error;
    }
  };
}
