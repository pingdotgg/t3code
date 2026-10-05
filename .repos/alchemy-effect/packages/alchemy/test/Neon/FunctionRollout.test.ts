import { Function } from "@/Neon/Function.ts";
import { Project } from "@/Neon/Project.ts";
import { providers } from "@/Neon/Providers.ts";
import * as Test from "@/Test/Alchemy.ts";
import { getProject, getProjectBranchFunction } from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import {
  functionRolloutSamples,
  functionRolloutTimeout,
} from "./FunctionRollout.ts";

const { test } = Test.make({ providers: providers() });
const Observation = Schema.Struct({
  version: Schema.String,
  environment: Schema.String,
  nonce: Schema.String,
  instance: Schema.String,
  requests: Schema.Number,
});

// Rollout convergence deliberately samples for minutes; skip under --fast.
test.provider.skipIf(!!process.env.FAST)(
  "polls warmed and uninvoked functions until the updated deployment serves consistently",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "neon-function-rollout-",
      });
      for (const version of ["one", "two"]) {
        const directory = path.join(root, version);
        yield* fs.makeDirectory(directory);
        yield* fs.writeFileString(
          path.join(directory, "index.mjs"),
          [
            `const version = ${JSON.stringify(version)};`,
            "const instance = crypto.randomUUID(); let requests = 0;",
            "export default { fetch(request) { return Response.json({",
            "version, instance, requests: ++requests, environment: process.env.ROLLOUT_VERSION,",
            'nonce: request.headers.get("x-rollout-nonce")',
            '}, { headers: { "cache-control": "no-store" } }); } };',
          ].join("\n"),
        );
      }
      const deploy = (version: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const project = yield* Project("Project", {
              region: "aws-us-east-2",
            });
            const warm = yield* Function("Warm", {
              project,
              artifact: { directory: path.join(root, version) },
              env: { ROLLOUT_VERSION: version },
            });
            const cold = yield* Function("Cold", {
              project,
              artifact: { directory: path.join(root, version) },
              env: { ROLLOUT_VERSION: version },
            });
            return { warm, cold };
          }),
        );
      const first = yield* deploy("one");
      let request = 0;
      const sample = Effect.fn(function* (
        url: string,
        slug: string,
        method: "GET" | "POST",
      ) {
        const nonce = `${slug}-${method}-${request++}`;
        const response = yield* HttpClient.execute(
          HttpClientRequest.make(method)(url).pipe(
            HttpClientRequest.setHeaders({
              "x-rollout-nonce": nonce,
              "cache-control": "no-cache",
              connection: "close",
            }),
          ),
        );
        expect(response.status).toBe(200);
        const body = yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Observation)),
        );
        expect(body.nonce).toBe(nonce);
        yield* Effect.logInfo(
          JSON.stringify({
            functionRolloutResponse: { slug, method, ...body },
          }),
        );
        return body;
      });
      for (let index = 0; index < 4; index++) {
        expect(
          yield* sample(first.warm.url, first.warm.slug, "GET"),
        ).toMatchObject({ version: "one", environment: "one" });
      }
      const updated = yield* deploy("two");
      for (const key of ["warm", "cold"] as const) {
        expect(updated[key].url).toBe(first[key].url);
        expect(updated[key].functionId).toBe(first[key].functionId);
        expect(updated[key].activeDeploymentId).not.toBe(
          first[key].activeDeploymentId,
        );
        const observed = yield* getProjectBranchFunction({
          project_id: updated[key].projectId,
          branch_id: updated[key].branchId,
          slug: updated[key].slug,
        });
        expect(observed.function.active_deployment?.id).toBe(
          updated[key].activeDeploymentId,
        );
        expect(observed.function.active_deployment?.status).toBe("completed");
      }
      const samples = yield* functionRolloutSamples(
        Effect.all(
          [
            sample(updated.warm.url, updated.warm.slug, "GET"),
            sample(updated.warm.url, updated.warm.slug, "POST"),
            sample(updated.cold.url, updated.cold.slug, "GET"),
            sample(updated.cold.url, updated.cold.slug, "POST"),
          ],
          { concurrency: 4 },
        ),
        (responses) =>
          responses.every(
            (body) => body.version === "two" && body.environment === "two",
          ),
      );
      for (const body of samples.flat())
        expect(body).toMatchObject({ version: "two", environment: "two" });
      const unchanged = yield* deploy("two");
      for (const key of ["warm", "cold"] as const)
        expect(unchanged[key].activeDeploymentId).toBe(
          updated[key].activeDeploymentId,
        );
      yield* stack.destroy();
      expect(
        yield* getProject({ project_id: updated.warm.projectId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
  {
    tags: [
      "provider:neon",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: functionRolloutTimeout,
  },
);
