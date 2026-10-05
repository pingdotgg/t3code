import { AIGateway } from "@/Neon/AIGateway.ts";
import { Branch } from "@/Neon/Branch.ts";
import { Credential } from "@/Neon/Credential.ts";
import { Project } from "@/Neon/Project.ts";
import { providers } from "@/Neon/Providers.ts";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

const { test } = Test.make({ providers: providers() });

test.provider(
  "gateway discovery performs no fake CRUD and scoped credentials are revoked",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Project("GatewayProject", {
            region: "aws-us-east-2",
          });
          const branch = yield* Branch("GatewayBranch", { project });
          const credential = yield* Credential("GatewayCredential", {
            branch,
            scopes: ["ai_gateway:invoke"],
          });
          const gateway = yield* AIGateway("Gateway", { branch, credential });
          return { branch, credential, baseUrl: gateway.baseUrl };
        }),
      );
      const request = {
        project_id: deployed.branch.projectId,
        branch_id: deployed.branch.branchId,
      };
      expect(
        (yield* SDK.getProjectBranchAiGateway(request)).base_url.replace(
          /\/$/,
          "",
        ),
      ).toBe(deployed.baseUrl);
      const http = yield* HttpClient.HttpClient;
      const models = yield* http.execute(
        HttpClientRequest.get(`${deployed.baseUrl}/v1/models`).pipe(
          HttpClientRequest.bearerToken(deployed.credential.apiToken),
        ),
      );
      expect(models.status).toBe(200);
      const catalog = yield* models.json.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              data: Schema.Array(
                Schema.Struct({ id: Schema.String, enabled: Schema.Boolean }),
              ),
            }),
          ),
        ),
      );
      expect(catalog.data.length).toBeGreaterThan(0);
      yield* Effect.log("Enabled Neon AI Gateway models", {
        models: catalog.data
          .filter((model) => model.enabled)
          .map((model) => model.id),
      });
      const list = yield* SDK.listCredentials(request);
      expect(
        list.credentials.find(
          (entry) => entry.token_id === deployed.credential.tokenId,
        )?.scopes,
      ).toContain("ai_gateway:invoke");
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
      "provider:neon",
      "provider:neon:aigateway",
      "provider:neon:branch",
      "provider:neon:credential",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider.skipIf(
  process.env.NEON_TEST_AI_PAID !== "1" || !process.env.NEON_TEST_AI_MODEL,
)(
  "paid model invocation is explicitly gated and never purchases credits",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Project("PaidGatewayProject", {
            region: "aws-us-east-2",
          });
          const credential = yield* Credential("PaidGatewayCredential", {
            project,
            scopes: ["ai_gateway:invoke"],
          });
          const gateway = yield* AIGateway("PaidGateway", {
            project,
            credential,
          });
          return { credential, baseUrl: gateway.baseUrl };
        }),
      );
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.execute(
        HttpClientRequest.post(`${deployed.baseUrl}/v1/chat/completions`).pipe(
          HttpClientRequest.bearerToken(deployed.credential.apiToken),
          HttpClientRequest.bodyJsonUnsafe({
            model: process.env.NEON_TEST_AI_MODEL,
            messages: [{ role: "user", content: "Reply with hello." }],
            max_tokens: 8,
          }),
        ),
      );
      if (response.status !== 200) {
        const body = yield* response.json;
        const error =
          typeof body === "object" && body !== null && "error" in body
            ? body.error
            : body;
        const message =
          typeof error === "object" && error !== null && "message" in error
            ? error.message
            : undefined;
        yield* Effect.log("Neon AI Gateway inference rejected", {
          status: response.status,
          message:
            typeof message === "string"
              ? message
                  .replaceAll(
                    Redacted.value(deployed.credential.apiToken),
                    "[REDACTED]",
                  )
                  .slice(0, 1000)
              : "No error message",
        });
      }
      expect(response.status).toBe(200);
      yield* stack.destroy();
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  {
    tags: [
      "provider:neon",
      "provider:neon:aigateway",
      "provider:neon:credential",
      "provider:neon:project",
      "live",
    ],
    timeout: 90_000,
  },
);
