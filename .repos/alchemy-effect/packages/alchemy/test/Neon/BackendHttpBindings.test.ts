import * as Cloudflare from "@/Cloudflare";
import * as Neon from "@/Neon";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import BackendHttpWorker from "./fixtures/backend-http-worker.ts";
import { backendBranch } from "./fixtures/backend-resources.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Neon.providers(), Cloudflare.providers()),
});

test.provider(
  "Worker HTTP bindings own an AI-scoped credential and revoke it with the host",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const application = (includeWorker: boolean) =>
        Effect.gen(function* () {
          const branch = yield* backendBranch;
          const worker = includeWorker ? yield* BackendHttpWorker : undefined;
          return { branch, url: worker?.url };
        });
      const deployed = yield* stack.deploy(application(true));
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const response = yield* http.get(deployed.url!).pipe(
        Effect.retry({
          schedule: Schedule.exponential("200 millis"),
          times: 7,
        }),
      );
      expect(response.status).toBe(200);
      expect(yield* response.json).toMatchObject({
        hasToken: true,
        sharedToken: true,
      });
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
      expect(credentials[0].scopes).not.toContain("storage:write");
      yield* stack.deploy(application(false));
      const remaining = (yield* SDK.listCredentials(
        request,
      )).credentials.filter(
        (item) => item.token_id === credentials[0].token_id && !item.revoked_at,
      );
      expect(remaining).toHaveLength(0);
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:neon",
      "provider:neon:aigateway",
      "provider:neon:auth",
      "provider:neon:branch",
      "provider:neon:dataapi",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
