import * as Effect from "effect/Effect";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyDeployTargetFinish,
  isDeployTarget,
  makeDeployTarget,
  resolveDeployTarget,
  resolveDeployTargetEntry,
  type BuildOutput,
  type DeployTarget,
} from "../index.ts";
import { makeProject, run } from "./helpers.ts";

const emptyBuild: BuildOutput = {
  clientDirectory: undefined,
  serverModules: undefined,
  externalWorkspaces: new Set(),
};

const stubTarget: DeployTarget = makeDeployTarget({
  platform: "cloudflare",
  config: { worker: { name: "test" } },
  bundle: { conditions: ["workerd", "worker"] },
});

describe("isDeployTarget", () => {
  it("accepts a target value", () => {
    expect(isDeployTarget(stubTarget)).toBe(true);
  });

  it("accepts extra framework-specific properties", () => {
    expect(
      isDeployTarget({ ...stubTarget, adapterPath: "/x/adapter.js" }),
    ).toBe(true);
  });

  it("rejects values missing platform or config", () => {
    expect(isDeployTarget({ config: {} })).toBe(false);
    expect(isDeployTarget({ platform: "cloudflare" })).toBe(false);
    expect(isDeployTarget({ platform: 42, config: {} })).toBe(false);
    expect(isDeployTarget(undefined)).toBe(false);
    expect(isDeployTarget("cloudflare")).toBe(false);
  });
});

describe("makeDeployTarget", () => {
  it("preserves the concrete type (identity)", () => {
    const target = makeDeployTarget({
      platform: "cloudflare",
      config: { compatibilityDate: "2026-03-10" },
    });
    expect(target.config.compatibilityDate).toBe("2026-03-10");
  });
});

describe("resolveDeployTargetEntry", () => {
  it("returns undefined when there is no target or no entry", () => {
    expect(
      resolveDeployTargetEntry(undefined, { root: "/project" }),
    ).toBeUndefined();
    expect(
      resolveDeployTargetEntry(stubTarget, { root: "/project" }),
    ).toBeUndefined();
  });

  it("resolves a root-relative user entry against the project root", () => {
    const target = makeDeployTarget({
      platform: "cloudflare",
      config: {},
      entry: { main: "./src/worker-entry.ts" },
    });
    expect(resolveDeployTargetEntry(target, { root: "/project" })).toBe(
      NodePath.resolve("/project", "src/worker-entry.ts"),
    );
  });

  it("keeps an absolute user entry as-is", () => {
    const main = NodePath.resolve("/elsewhere/entry.ts");
    const target = makeDeployTarget({
      platform: "cloudflare",
      config: {},
      entry: { main },
    });
    expect(resolveDeployTargetEntry(target, { root: "/project" })).toBe(main);
  });
});

describe("applyDeployTargetFinish", () => {
  it("passes the build through when the target has no finishing pass", async () => {
    const output = await run(
      applyDeployTargetFinish(stubTarget, emptyBuild, { root: "/tmp" }),
    );
    expect(output).toBe(emptyBuild);
  });

  it("passes the build through when there is no target", async () => {
    const output = await run(
      applyDeployTargetFinish(undefined, emptyBuild, { root: "/tmp" }),
    );
    expect(output).toBe(emptyBuild);
  });

  it("runs the target's finishing pass with the context", async () => {
    const finished: BuildOutput = {
      ...emptyBuild,
      clientDirectory: "/finished",
    };
    const seen: Array<string | undefined> = [];
    const target: DeployTarget = {
      ...stubTarget,
      finish: (output, context) =>
        Effect.sync(() => {
          seen.push(context.entry, output.clientDirectory);
          return finished;
        }),
    };
    const output = await run(
      applyDeployTargetFinish(target, emptyBuild, {
        root: "/tmp",
        entry: "/tmp/_worker.js",
      }),
    );
    expect(output).toBe(finished);
    expect(seen).toEqual(["/tmp/_worker.js", undefined]);
  });
});

describe("resolveDeployTarget", () => {
  it("returns a target value as-is", async () => {
    const target = await run(
      resolveDeployTarget("/tmp", stubTarget, undefined),
    );
    expect(target).toBe(stubTarget);
  });

  it("applies a factory to the config", async () => {
    const factory = (config: { name: string }) =>
      makeDeployTarget({ platform: "cloudflare", config });
    const target = await run(
      resolveDeployTarget("/tmp", factory, { name: "from-config" }),
    );
    expect(target.config).toEqual({ name: "from-config" });
  });

  it("loads a specifier from the project's node_modules (default export factory)", async () => {
    const root = await makeProject({
      "node_modules/test-target/package.json": JSON.stringify({
        name: "test-target",
        type: "module",
        exports: { ".": "./index.js" },
      }),
      "node_modules/test-target/index.js":
        "export default (config) => ({ platform: 'cloudflare', config });",
    });
    const target = await run(
      resolveDeployTarget<DeployTarget, { flag: boolean }>(
        root,
        "test-target",
        { flag: true },
      ),
    );
    expect(target.platform).toBe("cloudflare");
    expect(target.config).toEqual({ flag: true });
  });

  it("accepts a named `target` export that is a plain value", async () => {
    const root = await makeProject({
      "node_modules/test-target-value/package.json": JSON.stringify({
        name: "test-target-value",
        type: "module",
        exports: { ".": "./index.js" },
      }),
      "node_modules/test-target-value/index.js":
        "export const target = { platform: 'aws', config: {} };",
    });
    const target = await run(
      resolveDeployTarget(root, "test-target-value", undefined),
    );
    expect(target.platform).toBe("aws");
  });

  it("fails with DeployTargetError for an unusable export", async () => {
    const root = await makeProject({
      "node_modules/bad-target/package.json": JSON.stringify({
        name: "bad-target",
        type: "module",
        exports: { ".": "./index.js" },
      }),
      "node_modules/bad-target/index.js":
        "export default { notATarget: true };",
    });
    const result = await run(
      Effect.result(resolveDeployTarget(root, "bad-target", undefined)),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("DeployTargetError");
    }
  });

  it("fails with DeployTargetError for an unresolvable specifier", async () => {
    const result = await run(
      Effect.result(
        resolveDeployTarget(
          "/tmp",
          "definitely-not-a-real-target-xyz",
          undefined,
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("DeployTargetError");
    }
  });
});
