import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

const describe = layer(NodeServices.layer);

describe("Prisma optional peers", (it) => {
  it.effect(
    "keeps provider and schema entrypoints independent of ORM runtime packages",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const entries = yield* Effect.forEach(
          [
            "../../../../prisma/src/index.ts",
            "../../../../prisma/src/ORM/Schema.ts",
            "../../../../prisma/src/ORM/generator.ts",
            "./fixtures/psl/generated/schemas.ts",
          ],
          (entry) => path.fromFileUrl(new URL(entry, import.meta.url)),
        );
        const result = yield* Effect.promise(() =>
          Bun.build({
            entrypoints: entries,
            target: "bun",
            packages: "external",
            plugins: [
              {
                name: "reject-optional-prisma-runtime",
                setup(build) {
                  build.onResolve({ filter: /^(@prisma\/orm-|arktype(?:\/|$))/ }, (args) => {
                    throw new Error(`Unexpected optional runtime import: ${args.path}`);
                  });
                },
              },
            ],
          }),
        );
        expect(result.success).toBe(true);
        expect(result.logs.filter((log) => log.level === "error")).toEqual([]);
      }),
    { tags: ["unit", "provider:prisma", "provider:prisma:orm", "local"] },
  );
});
