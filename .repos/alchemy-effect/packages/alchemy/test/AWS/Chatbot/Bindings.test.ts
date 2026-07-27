import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import ChatbotTestFunctionLive, { ChatbotTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ChatbotBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy). Retry only
// 5xx; a genuine 4xx/assertion failure surfaces immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

// The testing account has no Slack workspace or Teams team onboarded, so the
// reads answer real empty lists (a REAL data-plane success through each
// binding's IAM grant) and the identity deletes answer typed error tags for
// the nonexistent identities.
describe.sequential("Chatbot Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Chatbot test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Chatbot test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* ChatbotTestFunction;
        }).pipe(Effect.provide(ChatbotTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Chatbot test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Chatbot test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 10 account-level capabilities initialize", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(10);
      }),
    );
  });

  describe("GetAccountPreferences", () => {
    test.provider(
      "succeeds end-to-end through the binding's IAM grant",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/account-preferences")) as {
            ok: boolean;
            hasPreferences: boolean;
          };
          expect(response.ok).toBe(true);
          expect(response.hasPreferences).toBe(true);
        }),
    );
  });

  describe("UpdateAccountPreferences", () => {
    test.provider(
      "no-op round-trip write succeeds through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson(
            "/account-preferences-roundtrip",
          )) as { ok: boolean; tag?: string };
          expect(response.ok).toBe(true);
        }),
    );
  });

  describe("DescribeSlackWorkspaces", () => {
    test.provider("answers the workspace list", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/slack-workspaces")) as {
          ok: boolean;
          count: number;
        };
        expect(response.ok).toBe(true);
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DescribeSlackUserIdentities", () => {
    test.provider("answers the identity list", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/slack-user-identities")) as {
          ok: boolean;
          count: number;
        };
        expect(response.ok).toBe(true);
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("ListMicrosoftTeamsConfiguredTeams", () => {
    test.provider("answers the configured team list", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/teams-configured-teams")) as {
          ok: boolean;
          count: number;
        };
        expect(response.ok).toBe(true);
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("ListMicrosoftTeamsUserIdentities", () => {
    test.provider("answers the identity list", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/teams-user-identities")) as {
          ok: boolean;
          count: number;
        };
        expect(response.ok).toBe(true);
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DeleteSlackUserIdentity", () => {
    test.provider("answers a typed tag for a nonexistent identity", (_stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* AWS.AWSEnvironment.current;
        const response = (yield* postJson(
          `/delete-slack-user-identity?account=${accountId}`,
        )) as {
          ok: boolean;
          tag?: string;
        };
        expect(response.ok).toBe(false);
        expect([
          "DeleteSlackUserIdentityException",
          "InvalidParameterException",
          "ResourceNotFoundException",
        ]).toContain(response.tag);
      }),
    );
  });

  describe("DeleteSlackWorkspaceAuthorization", () => {
    test.provider(
      "answers idempotently or with a typed tag for a workspace that was never onboarded",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson(
            "/delete-slack-workspace-authorization",
          )) as { ok: boolean; tag?: string };
          if (!response.ok) {
            expect([
              "DeleteSlackWorkspaceAuthorizationFault",
              "InvalidParameterException",
            ]).toContain(response.tag);
          }
        }),
    );
  });

  describe("DeleteMicrosoftTeamsUserIdentity", () => {
    test.provider("answers a typed tag for a nonexistent identity", (_stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* AWS.AWSEnvironment.current;
        const response = (yield* postJson(
          `/delete-teams-user-identity?account=${accountId}`,
        )) as {
          ok: boolean;
          tag?: string;
        };
        expect(response.ok).toBe(false);
        expect([
          "DeleteMicrosoftTeamsUserIdentityException",
          "InvalidParameterException",
          "ResourceNotFoundException",
        ]).toContain(response.tag);
      }),
    );
  });

  describe("DeleteMicrosoftTeamsConfiguredTeam", () => {
    test.provider(
      "answers the typed not-found tag for a team that was never onboarded",
      (_stack) =>
        Effect.gen(function* () {
          // ResourceNotFoundException is outside the Smithy model's union
          // for this operation — patched in distilled patches/chatbot.json.
          const response = (yield* postJson(
            "/delete-teams-configured-team",
          )) as { ok: boolean; tag?: string };
          if (!response.ok) {
            expect([
              "DeleteTeamsConfiguredTeamException",
              "InvalidParameterException",
              "ResourceNotFoundException",
            ]).toContain(response.tag);
          }
        }),
    );
  });
});
