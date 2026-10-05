import * as Neon from "@/Neon";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import BackendEffect from "./fixtures/backend-effect.ts";
import { backendBranch, backendDataApi } from "./fixtures/backend-resources.ts";

const { test } = Test.make({ providers: Neon.providers() });

test.provider(
  "native and Effect backend configuration use injected credentials without account keys",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const branch = yield* backendBranch;
          const data = yield* backendDataApi;
          const native = yield* Neon.Function("BackendNative", {
            branch: { projectId: data.projectId, branchId: data.branchId },
            main: "./test/Neon/fixtures/backend-native.ts",
          });
          const effect = yield* BackendEffect;
          return { branch, native, effect };
        }),
      );
      const http = yield* HttpClient.HttpClient;
      const native = yield* http
        .get(deployed.native.url)
        .pipe(Effect.flatMap((response) => response.json));
      const effect = yield* http
        .get(deployed.effect.url)
        .pipe(Effect.flatMap((response) => response.json));
      expect(native).toMatchObject({ hasToken: true, hasDeploymentKey: false });
      expect(effect).toMatchObject({ hasToken: true });
      const credentials = yield* SDK.listCredentials({
        project_id: deployed.branch.projectId,
        branch_id: deployed.branch.branchId,
      });
      expect(
        credentials.credentials.filter(
          (item) =>
            item.principal_type === "user" &&
            item.branch_id === deployed.branch.branchId &&
            !item.revoked_at,
        ),
      ).toHaveLength(0);
      const rejected = yield* http
        .get(`${deployed.effect.url}/data-foreign-origin`)
        .pipe(Effect.flatMap((response) => response.json));
      expect(rejected).toEqual({ rejected: true });
      const unauthorized = yield* http
        .get(`${deployed.effect.url}/data-invalid-token`)
        .pipe(Effect.flatMap((response) => response.text));
      expect(unauthorized).toBe("400");
      yield* stack.destroy();
      expect(
        yield* SDK.getProjectBranch({
          project_id: deployed.branch.projectId,
          branch_id: deployed.branch.branchId,
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
      "provider:neon:aigateway",
      "provider:neon:auth",
      "provider:neon:branch",
      "provider:neon:dataapi",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
