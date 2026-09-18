import { AlchemyContext } from "@/AlchemyContext";
import * as Bundle from "@/Bundle/Bundle";
import * as Provider from "@/Provider";
import { ServiceProvider } from "@/Railway/ServiceProvider";
import { FunctionProvider } from "@/Railway/Function";
import * as Layer from "effect/Layer";
import * as Railway from "@/Railway";
import { RailwayEnvironment } from "@/Railway/Environment";
import { Credentials } from "@distilled.cloud/railway";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  createRailwayFunctionSupport,
  createRailwayHostedSupport,
} from "@/Railway/hosted";
import { Stack } from "@/Stack";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const { test } = Test.make({
  providers: Layer.mergeAll(ServiceProvider(), FunctionProvider()).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          Credentials,
          Effect.die("Offline diff must not resolve credentials"),
        ),
        Layer.succeed(
          RailwayEnvironment,
          Effect.die("Offline diff must not resolve environment"),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.die("Offline diff must not make HTTP requests"),
          ),
        ),
      ),
    ),
  ),
});

for (const kind of ["Service", "Function"] as const) {
  test.provider(
    `${kind} detects code edits with runtime exports`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stack = yield* Stack;
        const { dotAlchemy } = yield* AlchemyContext;
        yield* fs.makeDirectory(path.resolve(".tmp"), { recursive: true });
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: path.resolve(".tmp"),
          prefix: "railway-code-diff-",
        });
        const main = path.join(directory, "main.ts");
        const source = (value: string) =>
          `export default { fetch: () => new Response(${JSON.stringify(value)}) };`;
        yield* fs.writeFileString(main, source("before"));
        const options = {
          stackName: stack.name,
          stage: stack.stage,
          dotAlchemy,
          virtualEntryPlugin: yield* Bundle.virtualEntryPlugin,
        };
        const hosted =
          kind === "Service"
            ? createRailwayHostedSupport(options)
            : createRailwayFunctionSupport(options);
        const props = {
          // Diff receives plain persisted attributes, although its public Props
          // type still describes the Resource with unresolved Output fields.
          project: {
            projectId: "project",
            name: "project",
            workspaceId: "workspace",
            environmentId: "environment",
            url: "https://railway.com/project/project",
          } satisfies Railway.Project["Attributes"] as unknown as Railway.Project,
          environment: { environmentId: "environment" },
          main,
          isExternal: true,
          port: 3000,
          // Platform supplies runtime exports as Effects during planning.
          exports: { fetch: Effect.succeed("runtime handler") },
        };
        const originalHash = yield* hosted.hash(props);
        const provider =
          kind === "Service"
            ? yield* Provider.findProvider(Railway.Service)
            : yield* Provider.findProvider(Railway.Function);
        const diff = (hash: string) =>
          provider.diff!({
            id: "Api",
            fqn: "Api",
            instanceId: "code-diff",
            olds: props,
            news: props,
            oldBindings: [],
            newBindings: [],
            // These are the persisted attributes consulted by both diff methods.
            output: {
              projectId: "project",
              environmentId: "environment",
              code: { hash },
            } as Railway.Service["Attributes"] & Railway.Function["Attributes"],
          });
        expect(yield* diff(originalHash)).toBeUndefined();
        yield* fs.writeFileString(main, source("after"));
        expect(yield* diff(originalHash)).toEqual({ action: "update" });
        const updatedHash = yield* hosted.hash(props);
        expect(updatedHash).not.toBe(originalHash);
        expect(yield* diff(updatedHash)).toBeUndefined();
      }),
    { timeout: 30_000 },
  );
}
