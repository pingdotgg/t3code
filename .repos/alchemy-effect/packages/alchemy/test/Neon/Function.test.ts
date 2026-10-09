import { Project } from "@/Neon/Project";
import { Function, type FunctionProps } from "@/Neon/Function";
import * as Provider from "@/Provider";
import { providers } from "@/Neon/Providers";
import * as Test from "@/Test/Alchemy";
import * as NeonApi from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import {
  functionRolloutSamples,
  functionRolloutTimeout,
  functionTextSamples,
} from "./FunctionRollout.ts";

const { test } = Test.make({ providers: providers() });

test.provider(
  "incomplete never-created Function rows have no recoverable physical identity",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const provider = yield* Provider.providerForMode(
        yield* Provider.Provider<Function>("Neon.Function"),
        "live",
      );
      const cases: FunctionProps[] = [
        { branch: { projectId: "", branchId: "" }, main: "never-created.ts" },
        {
          branch: { projectId: "project", branchId: "" },
          main: "never-created.ts",
        },
        {
          branch: { projectId: "", branchId: "branch" },
          main: "never-created.ts",
        },
        { project: { projectId: "" }, main: "never-created.ts" },
      ];
      for (const olds of cases) {
        expect(
          yield* provider.read!({
            id: "Incomplete",
            fqn: "Incomplete",
            instanceId: "never-created",
            olds,
            output: undefined,
          }),
        ).toBeUndefined();
      }
      yield* stack.destroy();
    }),
  {
    tags: ["provider:neon", "provider:neon:function", "live"],
    timeout: 120_000,
  },
);

// Live lifecycles below poll deployment rollout for minutes; skip under --fast.
test.provider.skipIf(!!process.env.FAST)(
  "native Function create, no-op, name update, environment removal and deletion",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const main = new URL("./fixtures/function-native.ts", import.meta.url)
        .href;
      const deploy = (env: Record<string, string>, name?: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const project = yield* Project("FunctionProject", {
              region: "aws-us-east-2",
            });
            const api = yield* Function("Api", { project, main, env, name });
            return { project, api };
          }),
        );
      const first = yield* deploy({
        FUNCTION_TEST_VALUE: "one",
        FUNCTION_TEST_REMOVED: "remove-me",
      });
      expect(first.api.slug).toMatch(/^[a-z0-9]{1,20}$/);
      expect(first.api.currentDeploymentId).toBe(first.api.activeDeploymentId);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(`${first.api.url}env`);
      expect(yield* response.json).toMatchObject({
        value: "one",
        removed: "remove-me",
        hasDatabase: true,
        hasAccountKey: false,
      });
      const observed = yield* NeonApi.getProjectBranchFunction({
        project_id: first.api.projectId,
        branch_id: first.api.branchId,
        slug: first.api.slug,
      });
      expect(observed.function.active_deployment?.id).toBe(
        first.api.activeDeploymentId,
      );
      const noop = yield* deploy({
        FUNCTION_TEST_VALUE: "one",
        FUNCTION_TEST_REMOVED: "remove-me",
      });
      expect(noop.api.activeDeploymentId).toBe(first.api.activeDeploymentId);
      const renamed = yield* deploy(
        { FUNCTION_TEST_VALUE: "one", FUNCTION_TEST_REMOVED: "remove-me" },
        "Friendly name",
      );
      expect(renamed.api.name).toBe("Friendly name");
      expect(renamed.api.activeDeploymentId).toBe(first.api.activeDeploymentId);
      const updated = yield* deploy({ FUNCTION_TEST_VALUE: "two" });
      expect(updated.api.functionId).toBe(first.api.functionId);
      expect(updated.api.name).toBe(first.api.slug);
      expect(updated.api.activeDeploymentId).not.toBe(
        first.api.activeDeploymentId,
      );
      expect(updated.api.url).toBe(first.api.url);
      const changedEnv = yield* functionRolloutSamples(
        client.get(`${updated.api.url}env`).pipe(
          Effect.flatMap((response) => {
            expect(response.status).toBe(200);
            return response.json;
          }),
        ),
        (body) =>
          typeof body === "object" &&
          body !== null &&
          "value" in body &&
          body.value === "two" &&
          !("removed" in body),
      );
      yield* Effect.logInfo(
        JSON.stringify({
          functionEnvironmentUpdate: {
            projectId: updated.api.projectId,
            branchId: updated.api.branchId,
            slug: updated.api.slug,
            previousDeployment: first.api.activeDeploymentId,
            activeDeployment: updated.api.activeDeploymentId,
            observed: changedEnv,
          },
        }),
      );
      for (const body of changedEnv) {
        expect(body).toMatchObject({ value: "two" });
        expect(body).not.toHaveProperty("removed");
      }
      const state = yield* NeonApi.getProjectBranchFunction({
        project_id: updated.api.projectId,
        branch_id: updated.api.branchId,
        slug: updated.api.slug,
      });
      expect(state.function.active_deployment?.environment).not.toContain(
        "FUNCTION_TEST_REMOVED",
      );
      yield* stack.deploy(
        Project("FunctionProject", { region: "aws-us-east-2" }),
      );
      const absent = yield* NeonApi.getProjectBranchFunction({
        project_id: updated.api.projectId,
        branch_id: updated.api.branchId,
        slug: updated.api.slug,
      }).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
      expect(absent).toBe(true);
      yield* stack.destroy();
    }),
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

test.provider.skipIf(!!process.env.FAST)(
  "code update after a config-only deployment serves the requested artifact",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (main: string, value: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const project = yield* Project("CodeProject", {
              region: "aws-us-east-2",
            });
            return yield* Function("Api", {
              project,
              main,
              env: { FUNCTION_TEST_VALUE: value },
            });
          }),
        );
      const main = new URL("./fixtures/function-native.ts", import.meta.url)
        .href;
      const first = yield* deploy(main, "one");
      const client = yield* HttpClient.HttpClient;
      expect(yield* (yield* client.get(first.url)).text).toBe("native-v1");
      const configured = yield* deploy(main, "two");
      const code = yield* deploy(
        new URL("./fixtures/function-bare.ts", import.meta.url).href,
        "two",
      );
      expect(code.codeHash).not.toBe(configured.codeHash);
      expect(code.activeDeploymentId).not.toBe(configured.activeDeploymentId);
      const observed = yield* NeonApi.getProjectBranchFunction({
        project_id: code.projectId,
        branch_id: code.branchId,
        slug: code.slug,
      });
      expect(observed.function.active_deployment?.id).toBe(
        code.activeDeploymentId,
      );
      yield* Effect.logInfo(
        JSON.stringify({
          functionCodeUpdate: {
            projectId: code.projectId,
            branchId: code.branchId,
            slug: code.slug,
            previousDeployment: configured.activeDeploymentId,
            activeDeployment: code.activeDeploymentId,
            status: observed.function.active_deployment?.status,
            previousCodeHash: configured.codeHash,
            codeHash: code.codeHash,
          },
        }),
      );
      expect(code.functionId).toBe(first.functionId);
      expect(code.url).toBe(first.url);
      const samples = yield* functionTextSamples(
        code.url,
        (body) => body === "bare-v2",
      );
      yield* Effect.logInfo(JSON.stringify({ functionStableUrl: samples }));
      const noop = yield* deploy(
        new URL("./fixtures/function-bare.ts", import.meta.url).href,
        "two",
      );
      expect(noop.activeDeploymentId).toBe(code.activeDeploymentId);
      yield* stack.destroy();
      expect(
        yield* NeonApi.getProject({ project_id: code.projectId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      for (const text of samples) expect(text).toBe("bare-v2");
    }),
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
