import { describe, expect, it } from "vitest";
import { NODE_BUNDLE_CONDITIONS } from "../../core/NodeServe.ts";
import {
  SERVER_ENTRYPOINT,
  distilledNode,
  makeNodeTarget,
  target,
} from "../node.ts";

describe("makeNodeTarget", () => {
  it("declares the node platform, Node bundle conditions, and a finish pass", () => {
    const node = makeNodeTarget();
    expect(node.platform).toBe("node");
    expect(node.bundle?.conditions).toEqual([...NODE_BUNDLE_CONDITIONS]);
    expect(node.bundle?.external ?? []).not.toContain("cloudflare:");
    expect(node.bundle?.external ?? []).not.toContain("@aws-sdk/");
    expect(node.build).toBeTypeOf("function");
    expect(node.finish).toBeTypeOf("function");
    expect(node.integration).toBeTypeOf("function");
  });

  it("pins the node-server entrypoint (not the aws-lambda wrapper)", () => {
    expect(SERVER_ENTRYPOINT).toBe(
      "@alchemy.run/frontend-frameworks/astro/entrypoints/node-server",
    );
    expect(SERVER_ENTRYPOINT).not.toContain("aws-server");
  });

  it("rejects a user-declared adapter at astro:config:done", () => {
    const integration = distilledNode();
    const setup = integration.hooks["astro:config:setup"];
    expect(setup).toBeTypeOf("function");
    const done = integration.hooks["astro:config:done"];
    expect(done).toBeTypeOf("function");
    expect(() =>
      (done as (ctx: never) => void)({
        setAdapter: () => {},
        config: {
          adapter: { name: "@astrojs/node" },
          build: { serverEntry: "entry.mjs" },
        },
        buildOutput: "server",
      } as never),
    ).toThrow(/already provides the Node adapter/);
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeNodeTarget);
  });
});
