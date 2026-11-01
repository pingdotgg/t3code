import { generate } from "@/Prisma/ORM/Generate.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/process";

const describe = layer(NodeServices.layer, { excludeTestServices: true });

describe("Effect contract generation", (it) => {
  it.effect(
    "emits deterministic PSL bindings, validates rows, and removes disabled outputs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixtures = yield* path.fromFileUrl(
          new URL("./fixtures", import.meta.url),
        );
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: fixtures,
          prefix: "generate-",
        });
        const source = yield* fs.readFileString(
          path.join(fixtures, "psl/contract.psl"),
        );
        yield* fs.writeFileString(path.join(directory, "contract.psl"), source);
        const config = (client: boolean, schemas: boolean) =>
          `import { defineConfig } from "@prisma/orm-postgres/config";\nimport { definePrismaConfig } from "prisma/config";\nimport { withEffect } from "alchemy/Prisma/ORM/generator";\nexport default definePrismaConfig({ orm: withEffect(defineConfig({ contract: "./contract.psl", output: "./generated" }), { client: ${client}, schemas: ${schemas} }) });\n`;
        for (const [name, client, schemas] of [
          ["both", true, true],
          ["schemas", false, true],
          ["client", true, false],
        ] as const) {
          yield* fs.writeFileString(
            path.join(directory, `${name}.config.ts`),
            config(client, schemas),
          );
        }
        const result = yield* generate(path.join(directory, "both.config.ts"));
        const before = yield* Effect.forEach(result.files, (file) =>
          fs.readFileString(file),
        );
        yield* generate(path.join(directory, "both.config.ts"));
        expect(
          yield* Effect.forEach(result.files, (file) =>
            fs.readFileString(file),
          ),
        ).toEqual(before);
        expect(result.files).toHaveLength(6);
        const schemaUrl = yield* path.toFileUrl(
          path.join(result.directory, "schemas.ts"),
        );
        const { schemas } = yield* Effect.promise(() => import(schemaUrl.href));
        expect(
          Schema.is(schemas.public.User)({
            id: 1,
            email: "a@example.com",
            name: null,
          }),
        ).toBe(true);
        expect(
          Schema.is(schemas.public.User)({
            id: "bad",
            email: "a@example.com",
            name: null,
          }),
        ).toBe(false);
        const standalone = yield* fs.readFileString(
          path.join(result.directory, "schemas.ts"),
        );
        expect(standalone).not.toContain('from "alchemy');
        expect(standalone).not.toContain("@prisma");
        yield* generate(path.join(directory, "schemas.config.ts"));
        expect(yield* fs.exists(path.join(result.directory, "client.ts"))).toBe(
          false,
        );
        expect(
          yield* fs.exists(path.join(result.directory, "runtime.ts")),
        ).toBe(false);
        expect(
          yield* fs.readFileString(path.join(result.directory, "index.ts")),
        ).not.toContain("makeDatabase");
        yield* generate(path.join(directory, "client.config.ts"));
        expect(
          yield* fs.exists(path.join(result.directory, "schemas.ts")),
        ).toBe(false);
        expect(yield* fs.exists(path.join(result.directory, "client.ts"))).toBe(
          true,
        );
        yield* fs.writeFileString(
          path.join(result.directory, "schemas.ts"),
          "// handwritten\n",
        );
        const refused = yield* generate(
          path.join(directory, "both.config.ts"),
        ).pipe(Effect.result);
        expect(Result.isFailure(refused)).toBe(true);
        expect(
          yield* fs.readFileString(path.join(result.directory, "schemas.ts")),
        ).toBe("// handwritten\n");
        yield* fs.remove(path.join(result.directory, "schemas.ts"));
        yield* fs.writeFileString(
          path.join(directory, "contract.psl"),
          "invalid contract",
        );
        const failed = yield* generate(
          path.join(directory, "both.config.ts"),
        ).pipe(Effect.result);
        expect(Result.isFailure(failed)).toBe(true);
        expect(
          yield* fs.readFileString(
            path.join(result.directory, "contract.json"),
          ),
        ).toBe(
          before[
            result.files.indexOf(path.join(result.directory, "contract.json"))
          ],
        );
      }).pipe(Effect.scoped),
    {
      tags: ["unit", "provider:prisma", "provider:prisma:orm", "local"],
      timeout: 120_000,
    },
  );

  it.effect(
    "watch regenerates imported TypeScript changes and recovers after invalid source",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixtures = yield* path.fromFileUrl(
          new URL("./fixtures", import.meta.url),
        );
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: fixtures,
          prefix: "watch-",
        });
        const config = path.join(directory, "prisma.config.ts");
        yield* fs.writeFileString(
          config,
          `import { defineConfig } from "@prisma/orm-postgres/config";\nimport { definePrismaConfig } from "prisma/config";\nimport { withEffect } from "alchemy/Prisma/ORM/generator";\nexport default definePrismaConfig({ orm: withEffect(defineConfig({ contract: "./contract.ts", output: "./generated" })) });\n`,
        );
        yield* fs.writeFileString(
          path.join(directory, "contract.ts"),
          `import { defineContract, field, model } from "alchemy/Prisma/ORM";\nimport { value } from "./fields.ts";\nexport const contract = defineContract({ models: { Item: model("Item", { fields: { id: field.column({ codecId: "pg/int4@1", nativeType: "int4" }).id(), value } }) } });\n`,
        );
        const fieldModule = (codec: "text" | "int4") =>
          `import { field } from "alchemy/Prisma/ORM";\nexport const value = field.column({ codecId: "pg/${codec}@1", nativeType: "${codec}" });\n`;
        const fields = path.join(directory, "fields.ts");
        yield* fs.writeFileString(fields, fieldModule("text"));
        const bin = yield* path.fromFileUrl(
          new URL("../../../bin/cli.js", import.meta.url),
        );
        const process = yield* ChildProcess.make(globalThis.process.execPath, [
          bin,
          "prisma",
          "generate",
          "--config",
          config,
          "--watch",
          "--no-input",
        ]);
        let output = "";
        yield* process.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach((text) =>
            Effect.sync(() => {
              output += text;
            }),
          ),
          Effect.forkScoped,
        );
        yield* process.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((text) =>
            Effect.sync(() => {
              output += text;
            }),
          ),
          Effect.forkScoped,
        );
        const wait = (condition: () => boolean) =>
          Effect.sync(condition).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: Boolean,
              times: 10,
            }),
            Effect.flatMap((ready) =>
              Effect.sync(() => expect(ready, output).toBe(true)),
            ),
          );
        yield* wait(() => output.includes("Watching"));
        const generated = path.join(directory, "generated/schemas.ts");
        const waitForField = (expression: string) =>
          fs.readFileString(generated).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (text) => text.includes(expression),
              times: 10,
            }),
            Effect.tap((text) =>
              Effect.sync(() => expect(text).toContain(expression)),
            ),
          );
        yield* fs.writeFileString(fields, fieldModule("int4"));
        yield* waitForField('"value": Schema.Int');
        yield* fs.writeFileString(fields, "invalid typescript");
        yield* wait(() => output.includes("Prisma.CliError"));
        yield* fs.writeFileString(fields, fieldModule("text"));
        yield* waitForField('"value": Schema.String');
      }).pipe(Effect.scoped),
    {
      tags: ["unit", "provider:prisma", "provider:prisma:orm", "local"],
      timeout: 120_000,
    },
  );
});
