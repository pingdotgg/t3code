import * as AWS from "@/AWS";
import * as Neon from "@/Neon";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import BackendHttpLambda from "./fixtures/backend-http-lambda.ts";
import { backendBranch } from "./fixtures/backend-resources.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Neon.providers(), AWS.providers()),
});

test.provider(
  "Lambda HTTP bindings expose only public URLs and a scoped gateway token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const branch = yield* backendBranch;
          const api = yield* BackendHttpLambda;
          return { branch, url: api.functionUrl };
        }),
      );
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.get(deployed.url!).pipe(
        Effect.retry({
          schedule: Schedule.exponential("200 millis"),
          times: 7,
        }),
      );
      expect(response.status).toBe(200);
      expect(yield* response.json).toMatchObject({ hasToken: true });
      const request = {
        project_id: deployed.branch.projectId,
        branch_id: deployed.branch.branchId,
      };
      const credentials = (yield* SDK.listCredentials(
        request,
      )).credentials.filter(
        (item) =>
          item.principal_type === "user" &&
          item.branch_id === deployed.branch.branchId &&
          !item.revoked_at,
      );
      expect(credentials).toHaveLength(1);
      expect(credentials[0].scopes).toContain("ai_gateway:invoke");
      yield* stack.destroy();
      expect(
        yield* SDK.getProjectBranch(request).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:lambda",
      "provider:neon",
      "provider:neon:aigateway",
      "provider:neon:auth",
      "provider:neon:branch",
      "provider:neon:dataapi",
      "provider:neon:project",
      "live",
    ],
    timeout: 240_000,
  },
);
