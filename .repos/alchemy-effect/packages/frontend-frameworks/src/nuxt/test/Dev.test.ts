import * as Effect from "effect/Effect";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  makeCloudflareDevPlatform,
  resolveClientModulePath,
  resolveDevPluginPath,
  type OpenDevProxy,
} from "../dev/host.ts";
import { RUNTIME_CONFIG_KEY, type DevConnectInfo } from "../dev/shared.ts";
import { fromHarnessOptions } from "../index.ts";

// The plugin runs inside nitro's dev SSR worker thread; in the test we stand
// in for nitro: `defineNitroPlugin` is identity and `useRuntimeConfig`
// serves whatever the test put in the holder.
const nitro = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock("nitropack/runtime", () => ({
  defineNitroPlugin: (plugin: unknown) => plugin,
  useRuntimeConfig: () => nitro.config,
}));

// The protocol constants the fake proxy server speaks (the same public
// subpath the runtime-free client is built on).
const loadProtocol = () =>
  import("@alchemy.run/cloudflare-runtime/core/platform-proxy/PlatformProxyProtocol");

const listen = (server: NodeHttp.Server): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as NodeNet.AddressInfo;
      resolve(`http://127.0.0.1:${address.port}/`);
    });
  });

const close = (server: NodeHttp.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

/** A fake platform-proxy: /env descriptor + a KV-ish /call implementation. */
const makeFakeProxy = async (token: string) => {
  const protocol = await loadProtocol();
  const store = new Map<string, string>();
  const server = NodeHttp.createServer((request, response) => {
    if (request.headers[protocol.HEADER_TOKEN] !== token) {
      response.statusCode = 401;
      response.end("unauthorized");
      return;
    }
    if (request.url === protocol.PATH_ENV) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          bindings: [
            {
              name: "TEXT",
              kind: "value",
              value: { $: "string", value: "hello" },
            },
            {
              name: "OVERRIDDEN",
              kind: "value",
              value: { $: "string", value: "proxied" },
            },
            { name: "KV", kind: "stub" },
          ],
        }),
      );
      return;
    }
    if (request.url === protocol.PATH_CALL) {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        const call = JSON.parse(body) as {
          binding: string;
          chain: Array<{
            method: string;
            args: Array<{ $: string; value?: unknown }>;
          }>;
        };
        const [segment] = call.chain;
        let result: unknown = null;
        if (segment?.method === "put") {
          store.set(
            String(segment.args[0]?.value),
            String(segment.args[1]?.value),
          );
          result = undefined;
        } else if (segment?.method === "get") {
          result = store.get(String(segment.args[0]?.value)) ?? null;
        }
        response.setHeader(protocol.HEADER_RESULT, "json");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ value: protocol.encodeValue(result) }));
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const url = await listen(server);
  return { url, close: () => close(server) };
};

/** Load the shipped dev plugin fresh and hand it a captured nitroApp. */
const setupPlugin = async (config: Record<string, unknown>) => {
  nitro.config = config;
  vi.resetModules();
  const { default: plugin } = (await import("../dev/plugin.ts")) as unknown as {
    default: (app: unknown) => void;
  };
  const hooks = new Map<string, (event: unknown) => Promise<void>>();
  plugin({
    hooks: {
      hook: (name: string, handler: (event: unknown) => Promise<void>) => {
        hooks.set(name, handler);
      },
    },
  });
  return hooks;
};

const makeEvent = () => ({
  context: {} as Record<string, unknown>,
  node: {
    req: {
      url: "/api/test?x=1",
      method: "GET",
      headers: { host: "localhost:3000", accept: "application/json" },
    },
  },
});

describe("module resolution", () => {
  it("resolves the shipped dev plugin next to the host module", () => {
    const path = resolveDevPluginPath();
    expect(path).toMatch(/dev[/\\]plugin\.(ts|js)$/);
    expect(NodeFs.existsSync(path)).toBe(true);
  });

  it("resolves the runtime-free client module from this package's dependencies", () => {
    const path = resolveClientModulePath();
    expect(path).toMatch(/platform-proxy[/\\]connect\./);
    expect(NodeFs.existsSync(path)).toBe(true);
  });
});

describe("makeCloudflareDevPlatform", () => {
  it("opens the proxy, injects the plugin + connect info, and disposes with the scope", async () => {
    let disposed = 0;
    let openedWith: Parameters<OpenDevProxy>[0] | undefined;
    const openProxy: OpenDevProxy = async (options) => {
      openedWith = options;
      return {
        url: "http://127.0.0.1:4321/",
        token: "test-token",
        dispose: async () => {
          disposed += 1;
        },
      };
    };
    const bindings = [{ kind: "text" }];
    const platform = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const platform = yield* makeCloudflareDevPlatform({
            openProxy,
            compatibilityDate: "2026-03-10",
            compatibilityFlags: ["nodejs_compat"],
          })({
            root: "/tmp/project",
            env: { LITERAL: "value", SKIPPED: { not: "a string" } },
            bindings,
          });
          // Still alive inside the scope.
          expect(disposed).toBe(0);
          return platform;
        }),
      ),
    );
    expect(disposed).toBe(1);
    expect(openedWith?.name).toBe("nuxt-dev-platform-proxy");
    expect(openedWith?.compatibilityDate).toBe("2026-03-10");
    expect(openedWith?.bindings).toBe(bindings);
    expect(platform.nitroPlugins).toEqual([resolveDevPluginPath()]);
    const info = (platform.runtimeConfig as Record<string, DevConnectInfo>)[
      RUNTIME_CONFIG_KEY
    ];
    expect(info).toBeDefined();
    expect(info?.url).toBe("http://127.0.0.1:4321/");
    expect(info?.token).toBe("test-token");
    expect(info?.clientModule).toBe(resolveClientModulePath());
    // Literal env: strings only.
    expect(info?.env).toEqual({ LITERAL: "value" });
  });

  it("maps the open failure onto DeployTargetError", async () => {
    const openProxy: OpenDevProxy = async () => {
      throw new Error("workerd exploded");
    };
    const result = await Effect.runPromise(
      Effect.result(
        Effect.scoped(
          makeCloudflareDevPlatform({ openProxy })({ root: "/tmp/project" }),
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const failure = result.failure as { _tag: string; message: string };
      expect(failure._tag).toBe("DeployTargetError");
      expect(failure.message).toContain(
        "Failed to open the dev platform proxy",
      );
    }
  });
});

describe("dev plugin (worker half)", () => {
  it("serves the cloudflare dev context through the runtime-free client", async () => {
    const token = "plugin-token";
    const proxy = await makeFakeProxy(token);
    try {
      const info: DevConnectInfo = {
        url: proxy.url,
        token,
        clientModule: resolveClientModulePath(),
        env: { OVERRIDDEN: "literal-wins" },
      };
      const hooks = await setupPlugin({ [RUNTIME_CONFIG_KEY]: info });
      const onRequest = hooks.get("request");
      expect(onRequest).toBeDefined();

      const event = makeEvent();
      await onRequest!(event);

      const cf = event.context.cf as Record<string, unknown>;
      expect(cf.country).toBe("US");
      // waitUntil is detachable (h3 consumers call it bare).
      const waitUntil = event.context.waitUntil as (
        promise: Promise<unknown>,
      ) => void;
      waitUntil(Promise.resolve());

      const cloudflare = event.context.cloudflare as {
        request: Request | undefined;
        env: Record<string, unknown>;
        context: { waitUntil: (promise: Promise<unknown>) => void };
      };
      expect(cloudflare.request?.url).toBe(
        "http://localhost:3000/api/test?x=1",
      );
      expect((cloudflare.request as { cf?: unknown } | undefined)?.cf).toBe(cf);
      expect(cloudflare.env.TEXT).toBe("hello");
      // Literal env overlay: a same-named literal wins over the proxied value.
      expect(cloudflare.env.OVERRIDDEN).toBe("literal-wins");
      const kv = cloudflare.env.KV as {
        put: (key: string, value: string) => Promise<void>;
        get: (key: string) => Promise<string | null>;
      };
      await kv.put("k", "v");
      expect(await kv.get("k")).toBe("v");
      expect(await kv.get("missing")).toBeNull();
    } finally {
      await proxy.close();
    }
  });

  it("stays inert without connect info", async () => {
    const hooks = await setupPlugin({});
    expect(hooks.size).toBe(0);
  });

  it("fails descriptively when the proxy rejects the token, then retries", async () => {
    const proxy = await makeFakeProxy("right-token");
    try {
      const info: DevConnectInfo = {
        url: proxy.url,
        token: "wrong-token",
        clientModule: resolveClientModulePath(),
      };
      const hooks = await setupPlugin({ [RUNTIME_CONFIG_KEY]: info });
      const onRequest = hooks.get("request");
      await expect(onRequest!(makeEvent())).rejects.toThrow(
        /\/env request failed with status 401/,
      );
      // The failed connection was not cached: the next request retries.
      await expect(onRequest!(makeEvent())).rejects.toThrow(
        /\/env request failed with status 401/,
      );
    } finally {
      await proxy.close();
    }
  });
});

describe("fromHarnessOptions (dev)", () => {
  it("passes the harness worker's binding hooks through to dev.bindings", () => {
    const bindings = [{ hook: true }];
    const options = fromHarnessOptions({
      target: { cloudflare: { worker: { worker: { bindings } } } },
    });
    expect(options.dev?.bindings).toBe(bindings);
  });
});
