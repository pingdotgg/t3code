/**
 * Build-output / option parity with upstream `@astrojs/cloudflare` v14.1.3:
 * zero-config sessions, `_redirects` generation, `_headers` immutable
 * Cache-Control, `base !== "/"` handling, `injectTypes`, the unsupported
 * upstream-option guard, and build-time env feeding.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as NodeFsPromises from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import cloudflareTarget, {
  distilledCloudflare,
  usesCloudflareKVSessionDriver,
  withDevSessionKv,
  withPrerenderSessionKv,
  type DistilledCloudflareOptions,
} from "../cloudflare.ts";
import {
  buildAssetsHeadersContent,
  headersFileHasCacheControlForPath,
} from "../headers.ts";
import { applyWorkerEnvToProcess } from "../source.ts";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

interface CapturedSetup {
  session?: {
    driver?: {
      entrypoint?: string | { toString(): string };
      config?: Record<string, unknown>;
    };
  };
}

const runConfigSetup = (
  options: DistilledCloudflareOptions | undefined,
  command: "dev" | "build",
  config: Record<string, unknown> = {},
): CapturedSetup => {
  const integration = distilledCloudflare(options);
  let captured: CapturedSetup | undefined;
  const hook = integration.hooks["astro:config:setup"];
  if (!hook) throw new Error("astro:config:setup hook missing");
  void hook({
    command,
    config: { vite: {}, image: {}, ...config },
    updateConfig: (update: unknown) => {
      captured = update as CapturedSetup;
      return {} as never;
    },
    logger: noopLogger,
  } as never);
  if (!captured) throw new Error("updateConfig was not called");
  return captured;
};

interface ConfigDoneContext {
  config: {
    base: string;
    trailingSlash?: "always" | "never" | "ignore";
    output?: string;
    build: {
      client: URL;
      server: URL;
      assets: string;
      assetsPrefix?: string | undefined;
      format?: string;
    };
  };
  injected: Array<{ filename: string; content: string }>;
}

const makeConfigDoneContext = (
  root: string,
  base = "/",
): ConfigDoneContext => ({
  config: {
    base,
    trailingSlash: "ignore",
    output: "server",
    build: {
      client: pathToFileURL(NodePath.join(root, "dist/client") + "/"),
      server: pathToFileURL(NodePath.join(root, "dist/server") + "/"),
      assets: "_astro",
      assetsPrefix: undefined,
      format: "directory",
    },
  },
  injected: [],
});

const runConfigDone = (
  integration: ReturnType<typeof distilledCloudflare>,
  ctx: ConfigDoneContext,
  buildOutput: "static" | "server" = "server",
) => {
  const hook = integration.hooks["astro:config:done"];
  if (!hook) throw new Error("astro:config:done hook missing");
  void hook({
    config: ctx.config,
    buildOutput,
    setAdapter: () => {},
    injectTypes: (injectedType: { filename: string; content: string }) => {
      ctx.injected.push(injectedType);
      return new URL("file:///dev/null");
    },
  } as never);
};

const runBuildDone = async (
  integration: ReturnType<typeof distilledCloudflare>,
  ctx: ConfigDoneContext,
  routes: Array<Record<string, unknown>> = [],
  root?: string,
) => {
  const routesHook = integration.hooks["astro:routes:resolved"];
  if (!routesHook) throw new Error("astro:routes:resolved hook missing");
  void routesHook({ routes } as never);
  const hook = integration.hooks["astro:build:done"];
  if (!hook) throw new Error("astro:build:done hook missing");
  await hook({
    dir: root
      ? pathToFileURL(NodePath.join(root, "dist") + "/")
      : new URL("file:///dev/null/"),
    assets: new Map(),
    pages: [],
    logger: noopLogger,
  } as never);
};

const tempDirs: Array<string> = [];
const makeTempRoot = async (): Promise<string> => {
  const root = await NodeFsPromises.mkdtemp(
    NodePath.join(NodeOs.tmpdir(), "distilled-astro-test-"),
  );
  tempDirs.push(root);
  return root;
};

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await NodeFsPromises.rm(dir, { recursive: true, force: true });
  }
});

describe("zero-config sessions", () => {
  it("defaults the session driver to Cloudflare KV when unset", () => {
    const captured = runConfigSetup(undefined, "build");
    expect(captured.session?.driver).toBeDefined();
    expect(usesCloudflareKVSessionDriver(captured.session as never)).toBe(true);
    expect(captured.session?.driver?.config).toMatchObject({
      binding: "SESSION",
    });
  });

  it("uses the configured sessionKVBindingName", () => {
    const captured = runConfigSetup(
      { sessionKVBindingName: "MY_SESSION" },
      "build",
    );
    expect(captured.session?.driver?.config).toMatchObject({
      binding: "MY_SESSION",
    });
  });

  it("leaves a user-configured driver untouched", () => {
    const userSession = { driver: "redis" };
    const captured = runConfigSetup(undefined, "build", {
      session: userSession,
    });
    expect(captured.session).toBe(userSession);
  });

  it("sessions: false leaves the session config untouched", () => {
    const captured = runConfigSetup({ sessions: false }, "build");
    expect(captured.session).toBeUndefined();
  });

  it("usesCloudflareKVSessionDriver matches by name and entrypoint", () => {
    expect(usesCloudflareKVSessionDriver(undefined)).toBe(false);
    expect(usesCloudflareKVSessionDriver({})).toBe(false);
    expect(
      usesCloudflareKVSessionDriver({ driver: "cloudflareKVBinding" }),
    ).toBe(true);
    expect(
      usesCloudflareKVSessionDriver({ driver: "cloudflare-kv-binding" }),
    ).toBe(true);
    expect(usesCloudflareKVSessionDriver({ driver: "redis" })).toBe(false);
    expect(
      usesCloudflareKVSessionDriver({
        driver: { entrypoint: "unstorage/drivers/cloudflare-kv-binding" },
      }),
    ).toBe(true);
    expect(
      usesCloudflareKVSessionDriver({
        driver: { entrypoint: "unstorage/drivers/redis" },
      }),
    ).toBe(false);
  });

  it("withDevSessionKv appends the local KV binding hook", () => {
    const marker = Effect.succeed({ name: "OTHER", text: "x" }) as never;
    const withExisting = withDevSessionKv(
      { worker: { name: "w", bindings: [marker] } as never },
      "SESSION",
    );
    expect(withExisting.worker?.name).toBe("w");
    expect(withExisting.worker?.bindings).toHaveLength(2);
    expect(withExisting.worker?.bindings?.[0]).toBe(marker);

    const fromScratch = withDevSessionKv(undefined, "SESSION");
    expect(fromScratch.worker?.bindings).toHaveLength(1);
  });

  it("withPrerenderSessionKv injects the local KV only when sessions need it", () => {
    const injected = withPrerenderSessionKv(undefined, {
      needsSessionKVBinding: true,
      sessionDevKV: true,
      binding: "SESSION",
    });
    expect(injected?.worker?.bindings).toHaveLength(1);

    const optedOut = withPrerenderSessionKv(undefined, {
      needsSessionKVBinding: true,
      sessionDevKV: false,
      binding: "SESSION",
    });
    expect(optedOut).toBeUndefined();

    const noSessions = withPrerenderSessionKv(
      { worker: { name: "w" } as never },
      { needsSessionKVBinding: false, sessionDevKV: true, binding: "SESSION" },
    );
    expect(noSessions?.worker?.bindings).toBeUndefined();
  });
});

describe("unsupported upstream options", () => {
  it("rejects upstream adapter options with a clear error", () => {
    expect(() =>
      distilledCloudflare({ imageService: "compile" } as never),
    ).toThrowError(
      /unsupported @astrojs\/cloudflare option[\s\S]*imageService[\s\S]*passthrough/,
    );
    expect(() =>
      distilledCloudflare({ configPath: "wrangler.json" } as never),
    ).toThrowError(/configPath/);
  });

  it("accepts the supported options", () => {
    expect(() =>
      distilledCloudflare({
        sessions: false,
        sessionDevKV: false,
        sessionKVBindingName: "S",
      }),
    ).not.toThrow();
  });
});

describe("astro:config:done", () => {
  it("injects the cloudflare.d.ts types reference", async () => {
    const root = await makeTempRoot();
    const integration = distilledCloudflare();
    const ctx = makeConfigDoneContext(root);
    runConfigDone(integration, ctx);
    expect(ctx.injected).toHaveLength(1);
    expect(ctx.injected[0]?.filename).toBe("cloudflare.d.ts");
    expect(ctx.injected[0]?.content).toContain(
      "@alchemy.run/frontend-frameworks/astro/types.d.ts",
    );
  });

  it("keeps build.client untouched for base '/'", async () => {
    const root = await makeTempRoot();
    const integration = distilledCloudflare();
    const ctx = makeConfigDoneContext(root, "/");
    const before = ctx.config.build.client.href;
    runConfigDone(integration, ctx);
    expect(ctx.config.build.client.href).toBe(before);
  });

  it("nests build.client under the base and reports the original directory", async () => {
    const root = await makeTempRoot();
    const reported: Array<string> = [];
    const integration = distilledCloudflare({
      onOriginalClientDir: (dir) => reported.push(dir),
    });
    const ctx = makeConfigDoneContext(root, "/docs");
    const original = ctx.config.build.client.href;
    runConfigDone(integration, ctx);
    expect(ctx.config.build.client.href).toBe(
      new URL("./docs/", original).href,
    );
    expect(reported).toHaveLength(1);
    expect(NodePath.resolve(reported[0]!)).toBe(
      NodePath.join(root, "dist/client"),
    );
  });
});

describe("astro:build:done", () => {
  const redirectRoute = {
    type: "redirect",
    pattern: "/old-about",
    pathname: "/old-about",
    entrypoint: undefined,
    redirect: "/about/",
    segments: [[{ content: "old-about", dynamic: false, spread: false }]],
  };

  it("writes _redirects for redirect routes and injects immutable _headers", async () => {
    const root = await makeTempRoot();
    const clientDir = NodePath.join(root, "dist/client");
    await NodeFsPromises.mkdir(clientDir, { recursive: true });
    const integration = distilledCloudflare();
    const ctx = makeConfigDoneContext(root);
    runConfigDone(integration, ctx);
    await runBuildDone(integration, ctx, [redirectRoute], root);

    const redirects = await NodeFsPromises.readFile(
      NodePath.join(clientDir, "_redirects"),
      "utf-8",
    );
    expect(redirects).toContain("/old-about");
    expect(redirects).toContain("/about/");
    expect(redirects).toContain("301");

    const headers = await NodeFsPromises.readFile(
      NodePath.join(clientDir, "_headers"),
      "utf-8",
    );
    expect(headers).toContain("/_astro/*");
    expect(headers).toContain(
      "Cache-Control: public, max-age=31536000, immutable",
    );
  });

  it("appends redirects to an existing _redirects and preserves user _headers rules", async () => {
    const root = await makeTempRoot();
    const clientDir = NodePath.join(root, "dist/client");
    await NodeFsPromises.mkdir(clientDir, { recursive: true });
    await NodeFsPromises.writeFile(
      NodePath.join(clientDir, "_redirects"),
      "/legacy / 302\n",
    );
    await NodeFsPromises.writeFile(
      NodePath.join(clientDir, "_headers"),
      "/api/*\n  X-Custom: yes\n",
    );
    const integration = distilledCloudflare();
    const ctx = makeConfigDoneContext(root);
    runConfigDone(integration, ctx);
    await runBuildDone(integration, ctx, [redirectRoute], root);

    const redirects = await NodeFsPromises.readFile(
      NodePath.join(clientDir, "_redirects"),
      "utf-8",
    );
    expect(redirects).toContain("/legacy / 302");
    expect(redirects).toContain("/old-about");

    const headers = await NodeFsPromises.readFile(
      NodePath.join(clientDir, "_headers"),
      "utf-8",
    );
    expect(headers).toContain("X-Custom: yes");
    expect(headers).toContain("/_astro/*");
  });

  it("leaves _headers alone when a matching Cache-Control rule already exists", async () => {
    const root = await makeTempRoot();
    const clientDir = NodePath.join(root, "dist/client");
    await NodeFsPromises.mkdir(clientDir, { recursive: true });
    const existing = "/_astro/*\n  Cache-Control: no-store\n";
    await NodeFsPromises.writeFile(
      NodePath.join(clientDir, "_headers"),
      existing,
    );
    const integration = distilledCloudflare();
    const ctx = makeConfigDoneContext(root);
    runConfigDone(integration, ctx);
    await runBuildDone(integration, ctx, [], root);
    const headers = await NodeFsPromises.readFile(
      NodePath.join(clientDir, "_headers"),
      "utf-8",
    );
    expect(headers).toBe(existing);
  });

  it("skips the Cache-Control injection when assetsPrefix is set", async () => {
    const root = await makeTempRoot();
    const clientDir = NodePath.join(root, "dist/client");
    await NodeFsPromises.mkdir(clientDir, { recursive: true });
    const integration = distilledCloudflare();
    const ctx = makeConfigDoneContext(root);
    ctx.config.build.assetsPrefix = "https://cdn.example.com";
    runConfigDone(integration, ctx);
    await runBuildDone(integration, ctx, [], root);
    await expect(
      NodeFsPromises.readFile(NodePath.join(clientDir, "_headers"), "utf-8"),
    ).rejects.toThrow();
  });

  it("with base !== '/', moves the special files up to the original client dir", async () => {
    const root = await makeTempRoot();
    const clientDir = NodePath.join(root, "dist/client");
    const nestedDir = NodePath.join(clientDir, "docs");
    await NodeFsPromises.mkdir(nestedDir, { recursive: true });
    // Astro writes the special files into the (remapped) client dir.
    await NodeFsPromises.writeFile(
      NodePath.join(nestedDir, "_redirects"),
      "/nested / 302\n",
    );
    await NodeFsPromises.writeFile(
      NodePath.join(nestedDir, ".assetsignore"),
      "secret.txt\n",
    );
    const integration = distilledCloudflare();
    const ctx = makeConfigDoneContext(root, "/docs");
    runConfigDone(integration, ctx);
    await runBuildDone(integration, ctx, [], root);

    const redirects = await NodeFsPromises.readFile(
      NodePath.join(clientDir, "_redirects"),
      "utf-8",
    );
    expect(redirects).toContain("/nested / 302");
    const ignore = await NodeFsPromises.readFile(
      NodePath.join(clientDir, ".assetsignore"),
      "utf-8",
    );
    expect(ignore).toContain("secret.txt");
    // The base-prefixed headers rule lands at the original client dir root.
    const headers = await NodeFsPromises.readFile(
      NodePath.join(clientDir, "_headers"),
      "utf-8",
    );
    expect(headers).toContain("/docs/_astro/*");
  });

  it("with base !== '/', 404.html survives the client-dir nesting (stays under the base)", async () => {
    const root = await makeTempRoot();
    const clientDir = NodePath.join(root, "dist/client");
    const nestedDir = NodePath.join(clientDir, "docs");
    await NodeFsPromises.mkdir(nestedDir, { recursive: true });
    // Astro writes the prerendered 404 page into the (remapped) client dir.
    await NodeFsPromises.writeFile(
      NodePath.join(nestedDir, "404.html"),
      "<h1>not found</h1>",
    );
    const integration = distilledCloudflare();
    const ctx = makeConfigDoneContext(root, "/docs");
    runConfigDone(integration, ctx, "static");
    await runBuildDone(integration, ctx, [], root);

    // Only the asset-server special files move up; the 404 page stays nested
    // under the base, where Cloudflare's `not_found_handling: "404-page"`
    // nearest-parent lookup finds it for every in-base URL.
    const nested404 = await NodeFsPromises.readFile(
      NodePath.join(nestedDir, "404.html"),
      "utf-8",
    );
    expect(nested404).toContain("not found");
  });
});

describe("cloudflare target finish (base !== '/')", () => {
  it("points clientDirectory back at the original client dir", async () => {
    const root = await makeTempRoot();
    const target = cloudflareTarget({});
    const integration = target.integration();
    const ctx = makeConfigDoneContext(root, "/docs");
    runConfigDone(integration, ctx);
    const nested = NodePath.join(root, "dist/client/docs");
    const output = {
      clientDirectory: nested,
      serverModules: undefined,
      externalWorkspaces: new Set<string>(),
    };
    const finished = await Effect.runPromise(
      target.finish!(output as never, {
        root,
        framework: "astro",
      }) as unknown as Effect.Effect<{
        clientDirectory: string | undefined;
      }>,
    );
    expect(finished.clientDirectory).toBe(NodePath.join(root, "dist/client"));
  });

  it("leaves the output untouched for base '/'", async () => {
    const root = await makeTempRoot();
    const target = cloudflareTarget({});
    const integration = target.integration();
    const ctx = makeConfigDoneContext(root, "/");
    runConfigDone(integration, ctx);
    const clientDirectory = NodePath.join(root, "dist/client");
    const output = {
      clientDirectory,
      serverModules: undefined,
      externalWorkspaces: new Set<string>(),
    };
    const finished = await Effect.runPromise(
      target.finish!(output as never, {
        root,
        framework: "astro",
      }) as unknown as Effect.Effect<{
        clientDirectory: string | undefined;
      }>,
    );
    expect(finished.clientDirectory).toBe(clientDirectory);
  });

  it("strips serverModules when the resolved buildOutput is static (assets-only)", async () => {
    const root = await makeTempRoot();
    const target = cloudflareTarget({});
    const integration = target.integration();
    const ctx = makeConfigDoneContext(root, "/");
    runConfigDone(integration, ctx, "static");
    const clientDirectory = NodePath.join(root, "dist/client");
    const output = {
      clientDirectory,
      // Astro bundles an SSR entry even for a fully-static build (it drives
      // prerendering); the finish pass must drop it from the deploy.
      serverModules: [{ name: "entry.mjs", content: "export default {}" }],
      externalWorkspaces: new Set<string>(),
    };
    const finished = await Effect.runPromise(
      target.finish!(output as never, {
        root,
        framework: "astro",
      }) as unknown as Effect.Effect<{
        clientDirectory: string | undefined;
        serverModules: unknown;
      }>,
    );
    expect(finished.serverModules).toBeUndefined();
    expect(finished.clientDirectory).toBe(clientDirectory);
  });

  it("static + base !== '/': assets-only AND clientDirectory back at the original dir", async () => {
    const root = await makeTempRoot();
    const target = cloudflareTarget({});
    const integration = target.integration();
    const ctx = makeConfigDoneContext(root, "/docs");
    runConfigDone(integration, ctx, "static");
    const nested = NodePath.join(root, "dist/client/docs");
    const output = {
      clientDirectory: nested,
      serverModules: [{ name: "entry.mjs", content: "export default {}" }],
      externalWorkspaces: new Set<string>(),
    };
    const finished = await Effect.runPromise(
      target.finish!(output as never, {
        root,
        framework: "astro",
      }) as unknown as Effect.Effect<{
        clientDirectory: string | undefined;
        serverModules: unknown;
      }>,
    );
    expect(finished.serverModules).toBeUndefined();
    expect(finished.clientDirectory).toBe(NodePath.join(root, "dist/client"));
  });
});

describe("headers utility", () => {
  it("detects existing Cache-Control rules (set and detach forms)", () => {
    expect(
      headersFileHasCacheControlForPath(
        "/_astro/*\n  Cache-Control: no-store\n",
        "/_astro/probe",
      ),
    ).toBe(true);
    expect(
      headersFileHasCacheControlForPath(
        "/_astro/*\n  ! Cache-Control\n",
        "/_astro/probe",
      ),
    ).toBe(true);
    expect(
      headersFileHasCacheControlForPath(
        "/api/*\n  Cache-Control: no-store\n",
        "/_astro/probe",
      ),
    ).toBe(false);
    expect(
      headersFileHasCacheControlForPath(
        "/_astro/*\n  X-Custom: 1\n",
        "/_astro/probe",
      ),
    ).toBe(false);
    expect(
      headersFileHasCacheControlForPath(
        "https://example.com/_astro/*\n  Cache-Control: no-store\n",
        "/_astro/probe",
      ),
    ).toBe(true);
    expect(
      headersFileHasCacheControlForPath(
        "/:dir/file\n  Cache-Control: x\n",
        "/_astro/file",
      ),
    ).toBe(true);
  });

  it("builds the immutable block, prepending it to existing content", async () => {
    const fresh = await buildAssetsHeadersContent(
      { assetsDir: "_astro", basePrefix: "", headersPath: "unused" },
      async () => {
        throw new Error("missing");
      },
    );
    expect(fresh?.assetsPattern).toBe("/_astro/*");
    expect(fresh?.content).toBe(
      "/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n",
    );

    const merged = await buildAssetsHeadersContent(
      { assetsDir: "_astro", basePrefix: "/docs", headersPath: "unused" },
      async () => "/api/*\n  X-Custom: yes",
    );
    expect(merged?.assetsPattern).toBe("/docs/_astro/*");
    expect(merged?.content).toContain("/docs/_astro/*\n  Cache-Control:");
    expect(merged?.content.endsWith("/api/*\n  X-Custom: yes\n")).toBe(true);
  });
});

describe("applyWorkerEnvToProcess", () => {
  it("applies literal env values and skips non-literals", async () => {
    const key = (suffix: string) => `DISTILLED_ASTRO_TEST_${suffix}`;
    for (const suffix of ["STR", "SECRET", "NUM", "BOOL", "EFFECT"]) {
      delete process.env[key(suffix)];
    }
    await Effect.runPromise(
      applyWorkerEnvToProcess({
        [key("STR")]: "plain",
        [key("SECRET")]: Redacted.make("hidden"),
        [key("NUM")]: 42,
        [key("BOOL")]: true,
        [key("EFFECT")]: Effect.succeed("nope"),
      }),
    );
    expect(process.env[key("STR")]).toBe("plain");
    expect(process.env[key("SECRET")]).toBe("hidden");
    expect(process.env[key("NUM")]).toBe("42");
    expect(process.env[key("BOOL")]).toBe("true");
    expect(process.env[key("EFFECT")]).toBeUndefined();
    for (const suffix of ["STR", "SECRET", "NUM", "BOOL"]) {
      delete process.env[key(suffix)];
    }
  });
});
