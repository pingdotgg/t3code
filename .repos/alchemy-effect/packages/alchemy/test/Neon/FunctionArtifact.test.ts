import {
  buildFunctionArtifact,
  validateFunctionZip,
} from "@/Neon/FunctionArtifact";
import { zipFiles } from "@/Util/zip";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const scope = { branch: { projectId: "project", branchId: "branch" } };

test.effect(
  "prebuilt directory and ZIP share a deterministic root-entry artifact",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        path.join(root, "index.mjs"),
        'export default { fetch: () => new Response("ok") };',
      );
      const first = yield* buildFunctionArtifact({
        ...scope,
        artifact: { directory: root },
      });
      const second = yield* buildFunctionArtifact({
        ...scope,
        artifact: { directory: root },
      });
      expect(second.codeHash).toBe(first.codeHash);
      const zip = path.join(yield* fs.makeTempDirectoryScoped(), "app.zip");
      yield* fs.writeFile(zip, first.archive);
      const prebuilt = yield* buildFunctionArtifact({
        ...scope,
        artifact: { zip },
      });
      expect(prebuilt.codeHash).toBe(first.codeHash);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { tags: ["unit", "provider:neon", "provider:neon:function", "local"] },
);

for (const name of [
  "../secret",
  "/secret",
  ".env",
  "nested/.env.production",
  "native.node",
  "nested//duplicate",
])
  test.effect(
    `rejects unsafe artifact path ${name}`,
    () =>
      Effect.gen(function* () {
        const zip = yield* zipFiles([
          { path: "index.mjs", content: "export default {};" },
          { path: name, content: "secret" },
        ]);
        const rejected = yield* validateFunctionZip(zip).pipe(
          Effect.as(false),
          Effect.catchTag("FunctionArtifactError", () => Effect.succeed(true)),
        );
        expect(rejected).toBe(true);
      }),
    { tags: ["unit", "provider:neon", "provider:neon:function", "local"] },
  );

for (const machine of [183, 62]) {
  test.effect(
    `Function ZIP validates native ELF architecture ${machine}`,
    () =>
      Effect.gen(function* () {
        const content = yield* Effect.sync(() => {
          const bytes = new Uint8Array(64);
          bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
          bytes[16] = 3;
          bytes[18] = machine;
          return bytes;
        });
        const zip = yield* zipFiles([
          { path: "index.mjs", content: "export default {};" },
          { path: "node_modules/addon/addon.node", content },
        ]);
        const accepted = yield* validateFunctionZip(zip).pipe(
          Effect.as(true),
          Effect.catchTag("FunctionArtifactError", () => Effect.succeed(false)),
        );
        expect(accepted).toBe(machine === 183);
      }),
    { tags: ["unit", "provider:neon", "provider:neon:function", "local"] },
  );
}

for (const [name, bytes] of [
  ["darwin.node", [0xcf, 0xfa, 0xed, 0xfe]],
  ["windows.dll", [0x4d, 0x5a]],
  ["library.so.1", [0]],
] as const) {
  test.effect(
    `Function ZIP rejects incompatible native file ${name}`,
    () =>
      Effect.gen(function* () {
        const zip = yield* zipFiles([
          { path: "index.mjs", content: "export default {};" },
          {
            path: name,
            content: yield* Effect.sync(() => new Uint8Array(bytes)),
          },
        ]);
        expect(
          yield* validateFunctionZip(zip).pipe(
            Effect.as(false),
            Effect.catchTag("FunctionArtifactError", () =>
              Effect.succeed(true),
            ),
          ),
        ).toBe(true);
      }),
    { tags: ["unit", "provider:neon", "provider:neon:function", "local"] },
  );
}

test.effect(
  "requires index.mjs at the ZIP root",
  () =>
    Effect.gen(function* () {
      const zip = yield* zipFiles([
        { path: "dist/index.mjs", content: "export default {};" },
      ]);
      expect(
        yield* validateFunctionZip(zip).pipe(
          Effect.as(false),
          Effect.catchTag("FunctionArtifactError", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }),
  { tags: ["unit", "provider:neon", "provider:neon:function", "local"] },
);

for (const tamper of ["local-header", "inflated-size"] as const)
  test.effect(
    `rejects ZIP ${tamper} size disagreement`,
    () =>
      Effect.gen(function* () {
        const archive = yield* zipFiles([
          { path: "index.mjs", content: "export default {};".repeat(1000) },
        ]);
        yield* Effect.sync(() => {
          const view = new DataView(
            archive.buffer,
            archive.byteOffset,
            archive.byteLength,
          );
          const directory = view.getUint32(archive.byteLength - 6, true);
          view.setUint32(22, 1, true);
          if (tamper === "inflated-size")
            view.setUint32(directory + 24, 1, true);
        });
        expect(
          yield* validateFunctionZip(archive).pipe(
            Effect.as(false),
            Effect.catchTag("FunctionArtifactError", () =>
              Effect.succeed(true),
            ),
          ),
        ).toBe(true);
      }),
    { tags: ["unit", "provider:neon", "provider:neon:function", "local"] },
  );

test.effect(
  "changing a native entrypoint changes uploaded bytes and digest",
  () =>
    Effect.gen(function* () {
      const first = yield* buildFunctionArtifact({
        ...scope,
        main: new URL("./fixtures/function-native.ts", import.meta.url).href,
        isExternal: true,
      });
      const second = yield* buildFunctionArtifact({
        ...scope,
        main: new URL("./fixtures/function-bare.ts", import.meta.url).href,
        isExternal: true,
      });
      expect(second.codeHash).not.toBe(first.codeHash);
      const files = yield* validateFunctionZip(second.archive);
      const entry = yield* Effect.sync(() =>
        new TextDecoder().decode(files["index.mjs"]),
      );
      expect(entry).toContain("bare-v2");
      expect(entry).not.toContain("native-v1");
    }).pipe(Effect.provide(NodeServices.layer)),
  { tags: ["unit", "provider:neon", "provider:neon:function", "local"] },
);

test.effect(
  "native bundle targets Node without a Bun or workerd bootstrap",
  () =>
    Effect.gen(function* () {
      const artifact = yield* buildFunctionArtifact({
        ...scope,
        main: new URL("./fixtures/function-native.ts", import.meta.url).href,
        isExternal: true,
      });
      const files = yield* validateFunctionZip(artifact.archive);
      const entry = yield* Effect.sync(() =>
        new TextDecoder().decode(files["index.mjs"]),
      );
      expect(entry).not.toContain("Bun.serve");
      expect(entry).not.toContain("cloudflare:workers");
      expect(entry).not.toContain("workerd");
      expect(entry).toContain("node:module");
    }).pipe(Effect.provide(NodeServices.layer)),
  { tags: ["unit", "provider:neon", "provider:neon:function", "local"] },
);
