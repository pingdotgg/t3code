import { adopt } from "@/AdoptPolicy.ts";
import { Auth } from "@/Neon/Auth.ts";
import { Branch } from "@/Neon/Branch.ts";
import { DataApi } from "@/Neon/DataApi.ts";
import { Project, waitForOperations } from "@/Neon/Project.ts";
import { providers } from "@/Neon/Providers.ts";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";

const { test } = Test.make({ providers: providers() });

test.provider(
  "Data API recovery treats incomplete uncreated identities as absent",
  () =>
    Effect.gen(function* () {
      const provider = yield* DataApi.Provider;
      const missingScope = {
        branch: {
          projectId: "uncreated-project",
          branchId: "uncreated-branch",
        },
      };
      const partialScope = {
        branch: {
          projectId: "uncreated-project",
          branchId: "uncreated-branch",
        },
      };
      yield* Effect.sync(() => {
        Reflect.deleteProperty(missingScope, "branch");
        Reflect.deleteProperty(partialScope.branch, "branchId");
      });
      for (const olds of [
        missingScope,
        partialScope,
        { branch: { projectId: "", branchId: "uncreated-branch" } },
        { project: { projectId: "" } },
      ]) {
        expect(
          yield* provider.read!({
            id: "UncreatedDataApi",
            fqn: "UncreatedDataApi",
            instanceId: "uncreated-data-api",
            olds,
            output: undefined,
          }),
        ).toBeUndefined();
      }
    }),
  { tags: ["provider:neon", "provider:neon:dataapi", "live"] },
);

test.provider(
  "Data API infers custom databases and rejects ambiguous selection before mutation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (
        selection: "infer" | "selected" | "explicit",
        rows = 10,
      ) =>
        Effect.gen(function* () {
          const project = yield* Project("SelectedDatabaseProject", {
            region: "aws-us-east-2",
            databaseName: "selected_app",
          });
          const auth = yield* Auth("SelectedDatabaseAuth", {
            project,
            database: "selected_app",
          });
          const api = yield* DataApi("SelectedDatabaseApi", {
            branch: {
              projectId: auth.projectId,
              branchId: auth.branchId,
              databaseName:
                selection === "selected" ? project.databaseName : undefined,
            },
            database: selection === "explicit" ? "selected_app" : undefined,
            authProvider: "neon_auth",
            settings: { db_max_rows: rows },
          });
          return { project, api };
        });
      const first = yield* stack.deploy(program("infer"));
      expect(first.api.database).toBe("selected_app");
      const request = {
        project_id: first.api.projectId,
        branch_id: first.api.branchId,
        database_name: first.api.database,
      };
      const database = yield* SDK.createProjectBranchDatabase({
        project_id: request.project_id,
        branch_id: request.branch_id,
        database: { name: "another_app", owner_name: first.project.roleName },
      });
      yield* waitForOperations(database.operations);
      const selected = yield* stack.deploy(program("selected"));
      expect(selected.api.url).toBe(first.api.url);
      const explicit = yield* stack.deploy(program("explicit"));
      expect(explicit.api.url).toBe(first.api.url);
      expect(
        yield* stack.deploy(program("infer", 50)).pipe(
          Effect.as(false),
          Effect.catchTag("InvalidDataApiConfiguration", () =>
            Effect.succeed(true),
          ),
        ),
      ).toBe(true);
      expect(
        (yield* SDK.getProjectBranchDataAPI(request)).settings?.db_max_rows,
      ).toBe(10);
      yield* stack.destroy();
      expect(
        yield* SDK.getProjectBranchDataAPI(request).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:auth",
      "provider:neon:dataapi",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "Data API refuses foreign ownership and explicitly adopts only settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const base = Effect.gen(function* () {
        const project = yield* Project("DataAdoptionProject", {
          region: "aws-us-east-2",
        });
        return yield* Auth("DataAdoptionAuth", { project });
      });
      const auth = yield* stack.deploy(base);
      const request = {
        project_id: auth.projectId,
        branch_id: auth.branchId,
        database_name: auth.database,
      };
      yield* SDK.createProjectBranchDataAPI({
        ...request,
        auth_provider: "neon_auth",
        add_default_grants: false,
        settings: { db_max_rows: 10 },
      });
      const program = (allow: boolean) =>
        Effect.gen(function* () {
          const auth = yield* base;
          return yield* DataApi("AdoptedDataApi", {
            branch: { projectId: auth.projectId, branchId: auth.branchId },
            database: auth.database,
            settings: { db_max_rows: 20 },
          }).pipe(adopt(allow));
        });
      expect(
        yield* stack.deploy(program(false)).pipe(
          Effect.as(false),
          Effect.catchTag("OwnedBySomeoneElse", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      expect(
        (yield* SDK.getProjectBranchDataAPI(request)).settings?.db_max_rows,
      ).toBe(10);
      const adopted = yield* stack.deploy(program(true));
      expect(adopted.database).toBe(auth.database);
      expect(
        (yield* SDK.getProjectBranchDataAPI(request)).settings?.db_max_rows,
      ).toBe(20);
      yield* stack.destroy();
      expect(
        yield* SDK.getProjectBranchDataAPI(request).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:auth",
      "provider:neon:dataapi",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "Data API replaces an unresolved new branch scope while retaining the old branch",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (second: boolean) =>
        Effect.gen(function* () {
          const project = yield* Project("DataScopeProject", {
            region: "aws-us-east-2",
          });
          const a = yield* Branch("DataScopeA", { project });
          const authA = yield* Auth("DataScopeAuthA", { branch: a });
          const b = second
            ? yield* Branch("DataScopeB", { project })
            : undefined;
          const auth = b ? yield* Auth("DataScopeAuthB", { branch: b }) : authA;
          const api = yield* DataApi("DataScopeApi", {
            branch: { projectId: auth.projectId, branchId: auth.branchId },
            database: auth.database,
            authProvider: "neon_auth",
          });
          return { a, b, api };
        });
      const first = yield* stack.deploy(program(false));
      const updated = yield* stack.deploy(program(true));
      expect(updated.api.branchId).toBe(updated.b!.branchId);
      expect(updated.a.branchId).toBe(first.a.branchId);
      expect(
        yield* SDK.getProjectBranchDataAPI({
          project_id: first.api.projectId,
          branch_id: first.api.branchId,
          database_name: first.api.database,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      expect(
        (yield* SDK.getNeonAuth({
          project_id: first.api.projectId,
          branch_id: first.api.branchId,
        })).base_url,
      ).toBeDefined();
      yield* stack.destroy();
      expect(
        yield* SDK.getProjectBranchDataAPI({
          project_id: updated.api.projectId,
          branch_id: updated.api.branchId,
          database_name: updated.api.database,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:auth",
      "provider:neon:branch",
      "provider:neon:dataapi",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "Data API lifecycle preserves identity and synchronizes observed settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const application = (rows: number | undefined) =>
        Effect.gen(function* () {
          const project = yield* Project("DataApiProject", {
            region: "aws-us-east-2",
          });
          const branch = yield* Branch("DataApiBranch", { project });
          const auth = yield* Auth("DataApiAuth", { branch });
          const api = yield* DataApi("DataApi", {
            branch: { projectId: auth.projectId, branchId: auth.branchId },
            authProvider: "neon_auth",
            settings: { db_max_rows: rows },
          });
          return { api, branch };
        });
      const first = yield* stack.deploy(application(10));
      const request = {
        project_id: first.api.projectId,
        branch_id: first.api.branchId,
        database_name: first.api.database,
      };
      expect((yield* SDK.getProjectBranchDataAPI(request)).url).toBe(
        first.api.url,
      );
      const unchanged = yield* stack.deploy(application(10));
      expect(unchanged.api.url).toBe(first.api.url);
      const updated = yield* stack.deploy(application(20));
      expect(updated.api.url).toBe(first.api.url);
      expect(
        (yield* SDK.getProjectBranchDataAPI(request)).settings?.db_max_rows,
      ).toBe(20);
      expect(
        yield* stack.deploy(application(undefined)).pipe(
          Effect.as(false),
          Effect.catchTag("InvalidDataApiConfiguration", () =>
            Effect.succeed(true),
          ),
        ),
      ).toBe(true);
      expect(
        (yield* SDK.getProjectBranchDataAPI(request)).settings?.db_max_rows,
      ).toBe(20);
      const http = yield* HttpClient.HttpClient;
      const denied = yield* http.get(first.api.url, {
        headers: { authorization: "Bearer invalid-user-token" },
      });
      expect(denied.status).toBe(400);
      expect(yield* denied.json).toMatchObject({
        message: "Provided authentication token is not a valid JWT encoding",
      });
      yield* stack.destroy();
      expect(
        yield* SDK.getProjectBranchDataAPI(request).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:auth",
      "provider:neon:branch",
      "provider:neon:dataapi",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
