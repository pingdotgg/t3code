import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import nativeAI from "../src/ai/native.ts";
import bare from "../src/forms/bare.ts";
import hono from "../src/forms/hono.ts";

const source = Effect.fn(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filename = yield* path.fromFileUrl(
    new URL(`../${file}`, import.meta.url),
  );
  return yield* fs.readFileString(filename);
});

test("all three stack configurations import without running deployment effects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const effect = yield* Effect.tryPromise(
        () => import("../alchemy.run.ts"),
      );
      const native = yield* Effect.tryPromise(
        () => import("../alchemy.native.ts"),
      );
      const preview = yield* Effect.tryPromise(
        () => import("../alchemy.preview.ts"),
      );
      expect(effect.default).toBeDefined();
      expect(native.default).toBeDefined();
      expect(preview.default).toBeDefined();
    }),
  ));

const files = [
  "src/resources.ts",
  "src/Api.ts",
  "src/Events.ts",
  "src/website.ts",
  "src/features.ts",
  "src/ai/resources.ts",
  "src/ai/index.ts",
  "src/ai/EffectApi.ts",
  "src/forms/index.ts",
  "src/forms/LayerApi.ts",
];

test("composition declares one Project and one Backend for every feature module", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const modules = yield* Effect.forEach(files, source);
      const combined = modules.join("\n");
      expect(combined.match(/Neon\.Project\(/g)).toHaveLength(1);
      expect(combined.match(/Neon\.Branch\(/g)).toHaveLength(1);
      expect(combined).not.toContain("Alchemy.Stack(");
      expect(modules[0]).toContain('Neon.Project("Project"');
      expect(modules[0]).toContain('Neon.Branch("Backend"');
      expect(modules[0]).toContain('access: "private"');
      expect(modules[0]).toContain('access: "public_read"');
      expect(modules[0]).toContain('key: "config/settings.json"');
      expect(modules[0]).toContain("schema: Schema.Struct(");
      expect(modules[1]).toContain("Neon.ConnectAuth(auth)");
      expect(modules[1]).toContain("Neon.ReadObject(settings)");
      for (const file of ["alchemy.run.ts", "alchemy.native.ts"]) {
        const stack = yield* source(file);
        expect(stack).toContain("yield* features");
        expect(stack).not.toContain("Neon.Project(");
      }
      const features = yield* source("src/features.ts");
      expect(features).toContain('enableAI === "true" ? yield* ai : undefined');
      expect(features).toContain(
        'enableForms === "true" ? yield* forms : undefined',
      );
      expect(features.match(/Config\.withDefault\("false"\)/g)).toHaveLength(2);
      for (const file of ["src/ai/index.ts", "src/ai/EffectApi.ts"]) {
        const ai = yield* source(file);
        expect(ai).toContain('Config.String("NEON_AI_ALLOW_PAID")');
        expect(ai).toContain('Config.withDefault("false")');
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  ));

test("cron writes are idempotent and the preview only enables its own upload trigger", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* source("src/Events.ts");
      const migration = yield* source("migrations/0002_scheduled_runs.sql");
      expect(events).toContain(
        'Neon.CronEventSource("Nightly", { cron: "0 2 * * *" }',
      );
      expect(events).toContain("ON CONFLICT DO NOTHING");
      expect(migration).toContain("invocation_id text PRIMARY KEY");
      const preview = yield* source("alchemy.preview.ts");
      expect(preview).toContain('"NeonUploadPreview"');
      expect(preview).toContain('name: "PreviewUploads"');
      expect(preview).not.toContain("yield* features");
      expect(preview).not.toContain("CronEventSource");
      expect(preview).not.toContain("Neon.CustomDomain(");
    }).pipe(Effect.provide(NodeServices.layer)),
  ));

const invokeNativeAI = Effect.fn(function* (options: {
  path?: string;
  method?: string;
  authorization?: string;
  body?: string;
  paid?: string;
}) {
  const names = ["EXAMPLE_API_KEY", "AI_MODEL", "AI_ALLOW_PAID"] as const;
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = names.map((name) => [name, process.env[name]] as const);
      process.env.EXAMPLE_API_KEY = "offline-example-secret";
      process.env.AI_MODEL = "never-call-this-model";
      if (options.paid === undefined) delete process.env.AI_ALLOW_PAID;
      else process.env.AI_ALLOW_PAID = options.paid;
      return previous;
    }),
    () =>
      Effect.gen(function* () {
        const method = options.method ?? "POST";
        const request = yield* Effect.sync(
          () =>
            new Request(`https://example.invalid${options.path ?? "/chat"}`, {
              method,
              body:
                method === "POST"
                  ? (options.body ?? '{"prompt":"Hello"}')
                  : undefined,
              headers: {
                "content-type": "application/json",
                ...(options.authorization === undefined
                  ? {}
                  : { authorization: options.authorization }),
              },
            }),
        );
        return yield* Effect.tryPromise(() => nativeAI.fetch(request));
      }),
    (previous) =>
      Effect.sync(() => {
        for (const [name, value] of previous) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }),
  );
});

for (const authorization of [undefined, "Bearer wrong"]) {
  test.serial(
    `native AI authenticates before parsing: ${authorization ?? "missing"}`,
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* invokeNativeAI({
            authorization,
            body: "not-json",
          });
          expect(response.status).toBe(401);
        }),
      ),
  );
}

for (const body of [
  "{",
  "{}",
  "null",
  '{"prompt":4}',
  '{"prompt":" "}',
  JSON.stringify({ prompt: "x".repeat(4001) }),
]) {
  test.serial(
    `native AI rejects invalid prompts before the paid gate: ${body.slice(0, 30)}`,
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* invokeNativeAI({
            authorization: "Bearer offline-example-secret",
            body,
          });
          expect(response.status).toBe(400);
        }),
      ),
  );
}

for (const paid of [undefined, "false", "1"]) {
  test.serial(
    `native AI refuses inference without exact opt-in: ${paid ?? "unset"}`,
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* invokeNativeAI({
            authorization: "Bearer offline-example-secret",
            paid,
          });
          expect(response.status).toBe(503);
          const body = yield* Effect.tryPromise(() => response.text());
          expect(body).not.toContain("offline-example-secret");
        }),
      ),
  );
}

test.serial(
  "native streaming UI and public handler forms remain usable offline",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const page = yield* invokeNativeAI({ path: "/", method: "GET" });
        expect(page.status).toBe(200);
        const html = yield* Effect.tryPromise(() => page.text());
        expect(html).toContain('id="cancel"');
        expect(html).toContain("AbortController");
        expect(html).toContain("text-delta");
        expect(html).not.toContain("offline-example-secret");
        expect(
          (yield* invokeNativeAI({ path: "/missing", method: "GET" })).status,
        ).toBe(404);
        const request = yield* Effect.sync(
          () => new Request("https://example.invalid/health"),
        );
        const bareResponse = yield* Effect.sync(() => bare(request));
        expect(yield* Effect.tryPromise(() => bareResponse.json())).toEqual({
          path: "/health",
        });
        const result = yield* Effect.sync(() => hono.fetch(request));
        const honoResponse =
          result instanceof Response
            ? result
            : yield* Effect.tryPromise(() => result);
        expect(yield* Effect.tryPromise(() => honoResponse.json())).toEqual({
          ok: true,
        });
      }),
    ),
);
