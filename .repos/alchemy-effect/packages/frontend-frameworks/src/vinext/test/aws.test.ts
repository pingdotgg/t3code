import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { describe, expect, it } from "vitest";
import {
  LAMBDA_ADAPTER_FILE_NAME,
  SERVE_ENTRY_NAME,
  makeAwsTarget,
  makeLambdaEntrySource,
  target,
} from "../aws.ts";
import { loadPrerenderPairs, seedStoreFromPrerender } from "../cache/seed.ts";

describe("makeAwsTarget", () => {
  it(
    "renders from an isolated Lambda directory without project dependencies",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* path.fromFileUrl(
              new URL("../../../../../examples/aws-website-vinext/", import.meta.url),
            );
            const configPath = path.join(root, "vite.config.ts");
            const configBefore = yield* fs.readFileString(configPath);
            expect(configBefore).not.toContain("@alchemy.run/frontend-frameworks");
            const built = yield* makeAwsTarget({ streaming: false }).build!({
              root,
              framework: "vinext",
            });
            expect(yield* fs.readFileString(configPath)).toBe(configBefore);
            expect(
              yield* fs.readFileString(path.join(built.distDirectory!, "server/index.js")),
            ).toContain("CACHE_BUCKET_NAME");
            const directory = yield* fs.makeTempDirectoryScoped({
              prefix: "vinext-lambda-",
            });
            yield* fs.copy(path.join(built.distDirectory!, "server"), directory);
            const prerender = yield* Effect.promise(() => loadPrerenderPairs(directory));
            expect(prerender.routeCount).toBeGreaterThan(0);
            expect(prerender.pairs.some((pair) => pair.key.includes("/isr"))).toBe(true);
            const values = new Map<string, string>();
            const store = {
              getText: (key: string) => Effect.runPromise(Effect.sync(() => values.get(key))),
              putText: (key: string, value: string) =>
                Effect.runPromise(
                  Effect.sync(() => {
                    values.set(key, value);
                  }),
                ),
              delete: (key: string) =>
                Effect.runPromise(
                  Effect.sync(() => {
                    values.delete(key);
                  }),
                ),
            };
            yield* Effect.promise(() => seedStoreFromPrerender(store, directory));
            const key = prerender.pairs[0]!.key;
            values.set(key, "refreshed at runtime");
            yield* Effect.promise(() => seedStoreFromPrerender(store, directory));
            expect(values.get(key)).toBe("refreshed at runtime");
            const spawner = yield* ChildProcessSpawner;
            const node = yield* Effect.sync(() => process.execPath);
            const child = yield* spawner.spawn(
              ChildProcess.make(
                node,
                [
                  "--input-type=module",
                  "--eval",
                  `
        import assert from "node:assert/strict";
        import { handler } from "./serve-aws-lambda.mjs";
        for (const route of ["/", "/isr", "/api/hello"]) {
          const response = await handler({ rawPath: route, rawQueryString: "name=Alchemy", requestContext: { domainName: "localhost", http: { method: "GET" } } });
          assert.equal(response.statusCode, 200);
          assert.ok(response.body.length > 0);
          if (route === "/") assert.match(response.body, /vinext on AWS/);
          if (route === "/api/hello") assert.equal(JSON.parse(response.body).greeting, "isolated Lambda");
        }
      `,
                ],
                {
                  cwd: directory,
                  env: { GREETING: "isolated Lambda" },
                  stdout: "inherit",
                  stderr: "inherit",
                },
              ),
            );
            expect(yield* child.exitCode).toBe(0);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      ),
    120_000,
  );
  it("declares the aws platform and a wholesale vinext build (not OpenNext)", () => {
    const aws = makeAwsTarget();
    expect(aws.platform).toBe("aws");
    expect(aws.build).toBeTypeOf("function");
    expect(aws.bundle?.conditions).toContain("node");
    expect(aws.bundle?.external).toContain("@aws-sdk/");
    expect(aws.bundle?.external ?? []).not.toContain("cloudflare:");
  });

  it("wraps the App Router fetch handler as a streaming Lambda handler", () => {
    const source = makeLambdaEntrySource(true);
    expect(SERVE_ENTRY_NAME).toBe("server/serve-aws-lambda.mjs");
    expect(LAMBDA_ADAPTER_FILE_NAME).toBe("vinext-aws-lambda.mjs");
    expect(source).toContain('import rsc from "./index.js"');
    expect(source).toContain("toLambdaHandler");
    expect(source).toContain("export const handler");
    expect(source).toContain('hostRuntime: "node"');
    expect(source).not.toContain("toBufferedLambdaHandler");
    expect(source).not.toContain("opennext");
    expect(source).not.toContain("vinext/server/fetch-handler");
    expect(source).not.toContain("startProdServer");
  });

  it("can emit the buffered Lambda wrapper", () => {
    const source = makeLambdaEntrySource(false);
    expect(source).toContain("toBufferedLambdaHandler");
    expect(source).not.toContain("toLambdaHandler");
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeAwsTarget);
  });
});
