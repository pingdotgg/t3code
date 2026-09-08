import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { describe, expect, it } from "vitest";
import { makeAwsTarget } from "../aws.ts";
import { fromHarnessOptions } from "../index.ts";
import {
  DEFAULT_TARGET_SPECIFIER,
  make,
  readNitroOutput,
  SERVER_ENTRY_NAME,
  type SolidStartTarget,
} from "../SolidStart.ts";

const runWithNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(NodeServices.layer),
    ) as Effect.Effect<A, E>,
  );

describe("readNitroOutput", () => {
  it("maps a nitro .output tree onto the BuildOutput contract, entry first", async () => {
    const output = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "solidstart-output-",
        });
        const serverDir = path.join(dir, "server");
        const publicDir = path.join(dir, "public");
        yield* fs.makeDirectory(path.join(serverDir, "chunks"), {
          recursive: true,
        });
        yield* fs.makeDirectory(publicDir, { recursive: true });
        // alphabetically before index.mjs, to prove entry-first sorting
        yield* fs.writeFileString(
          path.join(serverDir, "chunks", "a.mjs"),
          "export const a = 1;",
        );
        yield* fs.writeFileString(
          path.join(serverDir, "index.mjs"),
          "export const handler = () => {};",
        );
        yield* fs.writeFileString(
          path.join(publicDir, "robots.txt"),
          "User-agent: *\n",
        );
        return yield* readNitroOutput({ dir, serverDir, publicDir });
      }),
    );
    expect(output.serverModules?.map((module) => module.name)).toEqual([
      SERVER_ENTRY_NAME,
      "server/chunks/a.mjs",
    ]);
    expect(output.serverModules?.[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(output.clientDirectory?.endsWith("public")).toBe(true);
    expect(output.distDirectory).toBeDefined();
    expect(output.externalWorkspaces.size).toBe(0);
  });

  it("fails when the server directory has no index.mjs entry", async () => {
    const result = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "solidstart-output-",
        });
        const serverDir = path.join(dir, "server");
        yield* fs.makeDirectory(serverDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(serverDir, "other.mjs"),
          "export const x = 1;",
        );
        return yield* Effect.result(
          readNitroOutput({
            dir,
            serverDir,
            publicDir: path.join(dir, "public"),
          }),
        );
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.failure)).toContain("server/index.mjs");
    }
  });
});

describe("make", () => {
  it("defaults to this package's AWS deploy target", () => {
    expect(DEFAULT_TARGET_SPECIFIER).toBe(
      "@alchemy.run/frontend-frameworks/solidstart/aws",
    );
  });

  it("rejects a caller-supplied nitro preset that fights the deploy target", async () => {
    const result = await runWithNode(
      Effect.gen(function* () {
        const framework = yield* make({
          root: "/tmp/does-not-matter",
          // The adapter-only target: no wholesale `build`, so the preset
          // conflict check runs before anything touches the project.
          target: adapterOnly(makeAwsTarget()),
          nitro: { preset: "netlify" },
        });
        return yield* Effect.result(
          framework.build({ root: "/tmp/does-not-matter" }),
        );
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("FrameworkError");
      expect(result.failure.message).toContain('"netlify"');
      expect(result.failure.message).toContain('"aws-lambda"');
    }
  });

  it("build fails with a descriptive FrameworkError outside a SolidStart project", async () => {
    // /tmp has no vite install: loading the project's Vite is the first
    // step after the target resolves and must surface a FrameworkError.
    const result = await runWithNode(
      Effect.gen(function* () {
        const framework = yield* make({
          root: "/tmp/does-not-matter",
          target: adapterOnly(makeAwsTarget()),
        });
        return yield* Effect.result(
          framework.build({ root: "/tmp/does-not-matter" }),
        );
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("FrameworkError");
      expect(result.failure.framework).toBe("solidstart");
    }
  });

  it("exposes the framework contract (build + dev)", async () => {
    const framework = await runWithNode(make({ root: "/tmp/does-not-matter" }));
    expect(typeof framework.build).toBe("function");
    expect(typeof framework.dev).toBe("function");
  });
});

describe("fromHarnessOptions", () => {
  it("forwards the harness's nitro overrides", () => {
    expect(
      fromHarnessOptions({ solidstart: { nitro: { prerender: {} } } }).nitro,
    ).toEqual({ prerender: {} });
    expect(fromHarnessOptions({}).nitro).toBeUndefined();
  });
});

/** Drop the wholesale `build` hook so the in-process pipeline runs. */
const adapterOnly = (target: SolidStartTarget): SolidStartTarget => {
  const { build: _build, ...rest } = target;
  return rest;
};
