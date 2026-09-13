import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { describe, expect, it } from "vitest";
import {
  NODE_BUNDLE_CONDITIONS,
  NODE_SERVE_ENTRY_FILE_NAME,
} from "../../core/NodeServe.ts";
import type { NitroConfigSlice } from "../UserConfig.ts";
import {
  NITRO_HANDLER_SPECIFIER,
  NITRO_PRESET,
  makeNodeTarget,
  target,
} from "../node.ts";

const runWithNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(NodeServices.layer),
    ) as Effect.Effect<A, E>,
  );

describe("makeNodeTarget", () => {
  it("declares the node platform, the node nitro preset, and a finish pass", () => {
    const node = makeNodeTarget();
    expect(node.platform).toBe("node");
    expect(node.nitroPreset).toBe(NITRO_PRESET);
    expect(NITRO_PRESET).toBe("node");
    expect(NITRO_PRESET).not.toBe("aws-lambda");
    expect(NITRO_PRESET).not.toBe("cloudflare_module");
    expect(node.bundle?.conditions).toEqual([...NODE_BUNDLE_CONDITIONS]);
    expect(node.bundle?.external ?? []).not.toContain("cloudflare:");
    expect(node.bundle?.external ?? []).not.toContain("@aws-sdk/");
    expect(node.build).toBeTypeOf("function");
    expect(node.finish).toBeTypeOf("function");
  });

  it("does not wire aws-lambda streaming on the nitro config", () => {
    const node = makeNodeTarget();
    const config: NitroConfigSlice = {};
    node.configureNitro?.(config, { root: "/project" });
    expect(config.awsLambda).toBeUndefined();
    expect(config.preset).toBeUndefined();
  });

  it("exports the node-listener handler specifier for user entries", () => {
    expect(NITRO_HANDLER_SPECIFIER).toBe(
      "nitropack/presets/node/runtime/node-listener",
    );
    expect(NITRO_HANDLER_SPECIFIER).not.toContain("aws-lambda");
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeNodeTarget);
  });
});

describe("finish", () => {
  it("wraps nitro's node-listener handler, not the aws-lambda handler", async () => {
    const output = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "solidstart-node-finish-",
        });
        const serverDir = path.join(dir, "server");
        const publicDir = path.join(dir, "public");
        yield* fs.makeDirectory(serverDir, { recursive: true });
        yield* fs.makeDirectory(publicDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(serverDir, "index.mjs"),
          "export const handler = () => {};",
        );
        const node = makeNodeTarget();
        return yield* node.finish!(
          {
            distDirectory: dir,
            clientDirectory: publicDir,
            serverModules: [],
            externalWorkspaces: new Set<string>(),
          },
          { root: dir, framework: "solidstart" },
        );
      }),
    );
    expect(output.serverModules?.[0]?.name).toBe(
      `server/${NODE_SERVE_ENTRY_FILE_NAME}`,
    );
    const source = String(output.serverModules?.[0]?.content);
    expect(source).toContain("/health");
    expect(source).toContain("process.env.PORT");
    expect(source).toContain(`import { handler } from "./index.mjs"`);
    expect(source).not.toContain("aws-lambda");
    expect(source).not.toContain("streamifyResponse");
    expect(source).not.toContain("workerd");
  });
});
