import * as Alchemy from "@/index";
import { Function } from "@/Neon/Function";
import { Project } from "@/Neon/Project";
import { providers } from "@/Neon/Providers";
import * as Test from "@/Test/Alchemy";
import * as Api from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";

const { test } = Test.make({ providers: providers(), dev: true });
test.provider(
  "local Function runs behind the RPC sidecar and restarts on env changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (value: string) =>
        stack.deploy(
          Function("LocalApi", {
            branch: { projectId: "local-project", branchId: "local-branch" },
            main: new URL("./fixtures/function-native.ts", import.meta.url)
              .href,
            env: { FUNCTION_TEST_VALUE: value },
          }),
        );
      const first = yield* deploy("one");
      expect(first.functionId).toMatch(/^dev:/);
      const client = yield* HttpClient.HttpClient;
      expect(yield* (yield* client.get(`${first.url}/env`)).json).toMatchObject(
        { value: "one", hasAccountKey: false },
      );
      const second = yield* deploy("two");
      expect(
        yield* (yield* client.get(`${second.url}/env`)).json,
      ).toMatchObject({ value: "two", hasAccountKey: false });
      yield* stack.destroy();
      expect(
        yield* client.get(second.url).pipe(
          Effect.timeout("5 seconds"),
          Effect.as(false),
          Effect.catchTag("HttpClientError", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }),
  {
    tags: ["provider:neon", "provider:neon:function", "local"],
    timeout: 120_000,
  },
);

test.provider(
  "remote Function opt-out uses the live provider and stamped cleanup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Project("RemoteFunctionProject", {
            region: "aws-us-east-2",
          });
          return yield* Function("RemoteApi", {
            project,
            main: new URL("./fixtures/function-bare.ts", import.meta.url).href,
          }).pipe(Alchemy.remote());
        }),
      );
      expect(first.functionId.startsWith("dev:")).toBe(false);
      const client = yield* HttpClient.HttpClient;
      expect(yield* (yield* client.get(first.url)).text).toBe("bare-v2");
      const observed = yield* Api.getProjectBranchFunction({
        project_id: first.projectId,
        branch_id: first.branchId,
        slug: first.slug,
      });
      expect(observed.function.id).toBe(first.functionId);
      yield* stack.destroy();
      expect(
        yield* Api.getProjectBranchFunction({
          project_id: first.projectId,
          branch_id: first.branchId,
          slug: first.slug,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
