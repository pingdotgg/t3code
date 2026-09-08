import * as NodeServices from "@effect/platform-node/NodeServices";
import { isDeployTarget, resolveDeployTarget } from "../../core/index.ts";
import type { BuildOutput } from "../../core/index.ts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { makeCloudflareTarget, target } from "../cloudflare.ts";
import type { SvelteKitTargetConfig } from "../index.ts";

const emptyBuild: BuildOutput = {
  clientDirectory: undefined,
  serverModules: undefined,
  externalWorkspaces: new Set(),
};

describe("makeCloudflareTarget", () => {
  it("is a DeployTarget for the cloudflare platform carrying its config", () => {
    const config: SvelteKitTargetConfig = {
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
      adapter: { notFoundHandling: "404-page" },
    };
    const cloudflare = makeCloudflareTarget(config);
    expect(isDeployTarget(cloudflare)).toBe(true);
    expect(cloudflare.platform).toBe("cloudflare");
    expect(cloudflare.config).toBe(config);
  });

  it("declares workerd bundle conditions and cloudflare: externals", () => {
    const cloudflare = makeCloudflareTarget();
    expect(cloudflare.bundle?.conditions).toEqual([
      "workerd",
      "worker",
      "module",
      "browser",
    ]);
    expect(cloudflare.bundle?.external).toEqual(["cloudflare:"]);
  });

  it("produces the in-memory kit adapter from the adapter hook", () => {
    const cloudflare = makeCloudflareTarget({
      adapter: { assetsBinding: "STATIC" },
    });
    const adapter = cloudflare.adapter({ root: "/tmp/project" });
    expect(adapter.name).toBe("@alchemy.run/frontend-frameworks/sveltekit");
    expect(adapter.result.current).toBeUndefined();
    expect(typeof adapter.adapt).toBe("function");
  });

  it("constructs a dev adapter with a proxy emulator and a dispose hook", async () => {
    const cloudflare = makeCloudflareTarget({
      compatibilityDate: "2026-03-10",
    });
    const adapter = cloudflare.adapter({
      root: "/tmp/project",
      dev: { env: { SECRET: "value" }, bindings: ["binding-hook"] },
    });
    // The emulator is proxy-backed (behavior covered in Adapter.test.ts with
    // an injected opener); here we only assert the wiring exists without
    // opening a real workerd instance.
    expect(typeof adapter.emulate).toBe("function");
    expect(typeof adapter.dispose).toBe("function");
    // dispose before any platform() call must not open (or await) a proxy
    await adapter.dispose?.();
  });

  it("omits the dev platform for production builds", async () => {
    const cloudflare = makeCloudflareTarget();
    const adapter = cloudflare.adapter({ root: "/tmp/project" });
    const emulator = await adapter.emulate?.();
    const platform = (await emulator?.platform?.({
      config: {},
      prerender: false,
    })) as { env: Record<string, unknown> };
    expect(platform.env).toEqual({});
  });

  it("fails the finishing pass without an on-disk worker entry", async () => {
    const cloudflare = makeCloudflareTarget();
    const error = await Effect.runPromise(
      Effect.flip(
        cloudflare.finish!(emptyBuild, { root: "/tmp/project" }).pipe(
          Effect.provide(NodeServices.layer),
        ) as Effect.Effect<never, unknown>,
      ),
    );
    expect(error).toMatchObject({
      _tag: "DeployTargetError",
      platform: "cloudflare",
    });
    expect(String((error as { message: string }).message)).toContain(
      "worker entry",
    );
  });
});

describe("resolveDeployTarget interop", () => {
  it("applies the factory form to the framework-assembled config", async () => {
    const config: SvelteKitTargetConfig = { compatibilityDate: "2026-03-10" };
    const resolved = await Effect.runPromise(
      resolveDeployTarget("/tmp/project", makeCloudflareTarget, config),
    );
    expect(resolved.platform).toBe("cloudflare");
    expect(resolved.config).toBe(config);
    expect(typeof resolved.adapter).toBe("function");
  });

  it("accepts a prebuilt target value as-is", async () => {
    const value = makeCloudflareTarget({
      compatibilityFlags: ["nodejs_compat"],
    });
    const resolved = await Effect.runPromise(
      resolveDeployTarget("/tmp/project", value, {}),
    );
    expect(resolved).toBe(value);
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeCloudflareTarget);
  });
});
