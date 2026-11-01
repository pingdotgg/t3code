import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare";
import type { Branch } from "@/Neon/Branch";
import { providers } from "@/Neon/Providers";
import { runSql } from "@/Neon/Migrations";
import * as Redacted from "effect/Redacted";
import * as Test from "@/Test/Alchemy";
import { getConnectionURI, getProjectBranch } from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import { ConnectBranch } from "./fixtures/connect-database.ts";
import ConnectLambda from "./fixtures/connect-lambda.ts";
import ConnectFunction from "./fixtures/connect-function.ts";
import ConnectWorker from "./fixtures/connect-worker.ts";
import ConnectProjectFunction from "./fixtures/connect-project-function.ts";

const { test: workerTest } = Test.make({
  providers: Layer.mergeAll(providers(), Cloudflare.providers()),
});
const { test: lambdaTest } = Test.make({
  providers: Layer.mergeAll(providers(), AWS.providers()),
});

const { test: functionTest } = Test.make({ providers: providers() });

const verify = Effect.fn(function* (
  url: string,
  branch: Branch["Attributes"],
  injected = false,
  parentInjected = false,
) {
  const parent = yield* getConnectionURI({
    project_id: branch.projectId,
    branch_id: branch.parentBranchId,
    database_name: branch.databaseName,
    role_name: branch.roleName,
    pooled: false,
  });
  yield* runSql(
    Redacted.make(parent.uri),
    "CREATE TABLE IF NOT EXISTS alchemy_connect_marker (value text); TRUNCATE alchemy_connect_marker; INSERT INTO alchemy_connect_marker VALUES ('parent');",
  );
  yield* runSql(
    Redacted.make(branch.connectionUri),
    "CREATE TABLE IF NOT EXISTS alchemy_connect_marker (value text); TRUNCATE alchemy_connect_marker; INSERT INTO alchemy_connect_marker VALUES ('branch');",
  );
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  yield* Effect.gen(function* () {
    const response = yield* client.get(url);
    expect(response.status).toBe(200);
    expect(yield* response.json).toEqual({
      database: branch.databaseName,
      directDatabase: branch.databaseName,
      parentDatabase: "neondb",
      branchMarker: "branch",
      directMarker: "branch",
      parentMarker: "parent",
      hasAccountKey: false,
      injected,
      parentInjected,
    });
  }).pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 8 }));
  const observed = yield* getProjectBranch({
    project_id: branch.projectId,
    branch_id: branch.branchId,
  });
  expect(observed.branch.id).toBe(branch.branchId);
  const direct = yield* getConnectionURI({
    project_id: branch.projectId,
    branch_id: branch.branchId,
    database_name: branch.databaseName,
    role_name: branch.roleName,
    pooled: false,
  });
  expect(branch.connectionUri === direct.uri).toBe(true);
});

functionTest.provider(
  "Connect uses injected same-branch and namespaced cross-branch Function environments",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { fn, branch } = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* ConnectFunction;
          const branch = yield* ConnectBranch;
          return { fn, branch };
        }),
      );
      yield* verify(fn.url, branch, true);
      yield* verify(fn.url, branch, true);
      yield* stack.destroy();
      expect(
        yield* getProjectBranch({
          project_id: branch.projectId,
          branch_id: branch.branchId,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

functionTest.provider(
  "Connect resolves injection for a raw default-project scope",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { fn, branch } = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* ConnectProjectFunction;
          const branch = yield* ConnectBranch;
          return { fn, branch };
        }),
      );
      yield* verify(fn.url, branch, false, true);
      yield* verify(fn.url, branch, false, true);
      yield* stack.destroy();
      expect(
        yield* getProjectBranch({
          project_id: branch.projectId,
          branch_id: branch.branchId,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

workerTest.provider(
  "Connect queries pooled and direct Postgres from a Worker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { worker, branch } = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* ConnectWorker;
          const branch = yield* ConnectBranch;
          return { worker, branch };
        }),
      );
      expect(worker.url).toBeDefined();
      yield* verify(worker.url!, branch);
      yield* verify(worker.url!, branch);
      yield* stack.destroy();
      expect(
        yield* getProjectBranch({
          project_id: branch.projectId,
          branch_id: branch.branchId,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

lambdaTest.provider(
  "Connect queries pooled and direct Postgres from Lambda",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { fn, branch } = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* ConnectLambda;
          const branch = yield* ConnectBranch;
          return { fn, branch };
        }),
      );
      expect(fn.functionUrl).toBeDefined();
      yield* verify(fn.functionUrl!, branch);
      yield* verify(fn.functionUrl!, branch);
      yield* stack.destroy();
      expect(
        yield* getProjectBranch({
          project_id: branch.projectId,
          branch_id: branch.branchId,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:lambda",
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:project",
      "live",
    ],
    timeout: 240_000,
  },
);
