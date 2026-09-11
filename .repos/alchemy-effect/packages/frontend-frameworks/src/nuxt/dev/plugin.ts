/**
 * Dev-only nitro plugin: serves the `cloudflare_module` preset's runtime
 * contract inside nitro's dev SSR worker thread, wrangler-free.
 *
 * Injected by the framework host (`Nuxt.dev()` via the Cloudflare target's
 * dev platform, `./host.ts`) through `overrides.nitro.plugins`; a project
 * running under its own `nuxi dev` never loads it. On every request it sets
 * (the same contract `nitro-cloudflare-dev` provides, and production serves
 * natively):
 *
 * - `event.context.cf` — the static `request.cf` mock;
 * - `event.context.waitUntil` — accepted and dropped (long-lived dev
 *   process: background work simply runs);
 * - `event.context.cloudflare = { request, env, context }` — `env` is the
 *   live proxied environment (bindings round-trip to the host's workerd
 *   instance over HTTP, so state is SHARED with the host proxy), `request`
 *   is a synthesized `Request` carrying `cf`, `context` is the no-op
 *   `ExecutionContext` mock.
 *
 * The platform is reconstructed by `cloudflare-runtime`'s runtime-free
 * client (`platform-proxy/connect`, imported by the absolute path the host
 * resolved into the connect info). The connection is established lazily on
 * the first request and re-created after a failure, so a nitro dev reload
 * (worker-thread replacement) reconnects on its own with binding state
 * intact. When the host proxy is gone, requests fail fast with a
 * descriptive cause instead of hanging.
 */
import type * as ConnectClient from "@alchemy.run/cloudflare-runtime/core/platform-proxy/connect";
import { defineNitroPlugin, useRuntimeConfig } from "nitropack/runtime";
import { pathToFileURL } from "node:url";
import { RUNTIME_CONFIG_KEY, type DevConnectInfo } from "./shared.ts";

/** The runtime-free client module's shape (`platform-proxy/connect`). */
type ConnectModule = typeof ConnectClient;

interface ConnectedPlatform {
  readonly module: ConnectModule;
  readonly env: Record<string, unknown>;
  readonly cf: Record<string, unknown>;
}

/** The structural slice of the h3 event the bridge touches. */
interface DevEventSlice {
  context: Record<string, unknown>;
  node?: {
    req?: {
      url?: string | undefined;
      method?: string | undefined;
      headers?: Record<string, string | Array<string> | undefined>;
      socket?: { encrypted?: boolean | undefined } | undefined;
    };
  };
}

const isConnectInfo = (value: unknown): value is DevConnectInfo =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as DevConnectInfo).url === "string" &&
  typeof (value as DevConnectInfo).token === "string" &&
  typeof (value as DevConnectInfo).clientModule === "string";

/**
 * Synthesize the per-event `Request` (what the preset's runtime hands the
 * worker). Body is intentionally omitted: the node request stream belongs
 * to h3's own body parsing — read bodies through h3 (`readBody`), not
 * `context.cloudflare.request`.
 */
const synthesizeRequest = (
  event: DevEventSlice,
  cf: Record<string, unknown>,
): Request | undefined => {
  try {
    const req = event.node?.req;
    if (req === undefined) return undefined;
    const host =
      (typeof req.headers?.host === "string" && req.headers.host) ||
      "localhost";
    const protocol = req.socket?.encrypted === true ? "https" : "http";
    const url = new URL(req.url ?? "/", `${protocol}://${host}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value))
        for (const entry of value) headers.append(name, entry);
    }
    const request = new Request(url.toString(), {
      method: req.method ?? "GET",
      headers,
    });
    Object.defineProperty(request, "cf", { value: cf, configurable: true });
    return request;
  } catch {
    return undefined;
  }
};

export default defineNitroPlugin((nitroApp) => {
  const config = useRuntimeConfig() as Record<string, unknown>;
  const info = config[RUNTIME_CONFIG_KEY];
  if (!isConnectInfo(info)) {
    // Not running under the distilled dev host — stay inert.
    return;
  }
  let connected: Promise<ConnectedPlatform> | undefined;
  const connect = () =>
    (connected ??= (async () => {
      const module = (await import(
        /* @vite-ignore */ pathToFileURL(info.clientModule).href
      )) as ConnectModule;
      const platform = await module.connect({
        url: info.url,
        token: info.token,
      });
      // Literal env values overlay the proxied bindings (a same-named
      // literal always wins).
      const env: Record<string, unknown> = { ...platform.env };
      for (const [name, value] of Object.entries(info.env ?? {})) {
        env[name] = value;
      }
      return { module, env, cf: platform.cf };
    })().catch((error: unknown) => {
      // Reset so the next request retries (host proxy restarts, races).
      connected = undefined;
      throw error;
    }));

  nitroApp.hooks.hook("request", async (event) => {
    const slice = event as unknown as DevEventSlice;
    const platform = await connect();
    const context = new platform.module.ExecutionContext();
    slice.context.cf = platform.cf;
    slice.context.waitUntil = context.waitUntil.bind(context);
    slice.context.cloudflare = {
      request: synthesizeRequest(slice, platform.cf),
      env: platform.env,
      context,
    };
  });
});
