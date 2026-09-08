/** Options for a `browser` (Browser Rendering) binding (local or remote). */
export interface BrowserProps {
  /** Binding name exposed on `env`. */
  readonly binding: string;
  /**
   * Launch Chrome with a visible window instead of headless mode.
   * @default false
   */
  readonly headful?: boolean;
}

/**
 * The Chrome browser version downloaded for the local Browser Rendering
 * simulator. Mirrors Miniflare's pin
 * (`workers-sdk/packages/miniflare/src/plugins/browser-rendering/browser-version.ts`):
 * it must match the supported Chrome version of the upstream puppeteer
 * release that `@cloudflare/puppeteer` branched from (puppeteer v22.13.1):
 * https://pptr.dev/supported-browsers
 *
 * Keeping the same pin as Miniflare also means the Chrome build is shared
 * with `wrangler dev` through the global wrangler cache directory.
 */
export const BROWSER_VERSION = "126.0.6478.182";

/**
 * A launched Chrome session, as returned by the node-side `/browser/launch`
 * loopback handler and stored in the `BrowserSession` Durable Object.
 * Mirrors Miniflare's `SessionInfo`
 * (`workers-sdk/packages/miniflare/src/workers/browser-rendering/binding.worker.ts`).
 */
export interface SessionInfo {
  /** Chrome's DevTools WebSocket endpoint (`ws://127.0.0.1:<port>/...`). */
  wsEndpoint: string;
  sessionId: string;
  startTime: number;
  connectionId?: string;
  connectionStartTime?: number;
}

/** The shared service hosting the Browser Rendering simulator. */
export const SERVICE_BROWSER = "browser";

/** Durable Object class managing one Chrome session per instance. */
export const BROWSER_SESSION_CLASS_NAME = "BrowserSession";

/** Loopback route the browser worker calls to launch/inspect/kill Chrome. */
export const LOOPBACK_TARGET_BROWSER = "browser";

/** Service binding the browser worker uses to reach the loopback route. */
export const BINDING_BROWSER_LOOPBACK = "SERVICE_LOOPBACK";

/** Durable Object namespace binding for {@link BROWSER_SESSION_CLASS_NAME}. */
export const BINDING_BROWSER_SESSION = "BrowserSession";
