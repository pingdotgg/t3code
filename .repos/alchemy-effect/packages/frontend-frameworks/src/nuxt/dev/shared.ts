/**
 * The contract shared between the two halves of the Cloudflare dev
 * transport:
 *
 * - the HOST half (`./host.ts`) runs in the alchemy/e2e process: it opens
 *   `cloudflare-runtime`'s platform proxy (a workerd instance hosting the
 *   configured bindings) and injects a {@link DevConnectInfo} into nitro's
 *   `runtimeConfig`;
 * - the WORKER half (`./plugin.ts`) is a nitro plugin bundled into nitro's
 *   dev SSR worker THREAD: it reads the {@link DevConnectInfo} back out of
 *   `useRuntimeConfig()` and reconstructs the proxied platform over HTTP
 *   with `cloudflare-runtime`'s runtime-free client
 *   (`platform-proxy/connect`).
 *
 * The entire client state of the platform proxy is `{ url, token }` — two
 * plain strings — which is what makes the worker-thread hop trivial:
 * `runtimeConfig` strings survive nitro's bundling and worker replacement,
 * so the plugin reconnects on its own after every dev reload while binding
 * state (KV, DO storage, ...) stays live in the host's workerd instance.
 */

/**
 * The `runtimeConfig` key the host writes the {@link DevConnectInfo} under
 * (private runtime config — server-side only, never exposed to the client).
 */
export const RUNTIME_CONFIG_KEY = "distilledCloudflareDev";

/** What the dev-only nitro plugin needs to reconstruct the platform env. */
export interface DevConnectInfo {
  /** Base URL of the platform-proxy workerd instance. */
  readonly url: string;
  /** The proxy instance's auth token (all proxy endpoints 401 without it). */
  readonly token: string;
  /**
   * Absolute path of `cloudflare-runtime`'s runtime-free platform-proxy
   * client module (`platform-proxy/connect`), resolved by the HOST from its
   * own dependency tree. The plugin dynamically imports it by path — the
   * dev worker cannot resolve the bare specifier itself when
   * `cloudflare-runtime` is only a transitive dependency of the project
   * (isolated installs expose direct dependencies only).
   */
  readonly clientModule: string;
  /**
   * Literal env values laid over the proxied bindings — a same-named
   * literal always wins (mirrors the SvelteKit dev platform's contract).
   */
  readonly env?: Record<string, string> | undefined;
}
