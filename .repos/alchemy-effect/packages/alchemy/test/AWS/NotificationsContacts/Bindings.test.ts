import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import NotificationsContactsTestFunctionLive, {
  NotificationsContactsTestFunction,
} from "./handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(
  testOptions,
  "NotificationsContactsBindings",
);

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

describe("NotificationsContacts Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "NotificationsContacts test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "NotificationsContacts test setup: deploying fixture",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* NotificationsContactsTestFunction;
        }).pipe(Effect.provide(NotificationsContactsTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `NotificationsContacts test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `NotificationsContacts test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("NotificationsContacts.GetEmailContact", () => {
    test.provider(
      "reads the bound contact's activation status",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* HttpClient.get(`${baseUrl}/contact`).pipe(
            Effect.flatMap((r) => r.json),
          )) as { arn: string; status: string };

          expect(response.arn).toContain(":emailcontact/");
          // Activation is a human email-confirmation loop; a fresh fixture
          // contact stays `inactive`.
          expect(["inactive", "active"]).toContain(response.status);
        }),
      { timeout: 120_000 },
    );
  });

  describe("NotificationsContacts.SendActivationCode", () => {
    test.provider(
      "sends the activation email to the bound contact",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* HttpClient.execute(
            HttpClientRequest.post(`${baseUrl}/send-code`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            sent: boolean;
            conflict: boolean;
          };

          // A successful send, or the typed ConflictException for an
          // already-active contact — either outcome proves the binding.
          expect(response.sent || response.conflict).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });

  describe("NotificationsContacts.ActivateEmailContact", () => {
    test.provider(
      "rejects a bogus activation code with a typed error",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* HttpClient.execute(
            HttpClientRequest.post(`${baseUrl}/activate-bogus`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            activated: boolean;
            errorTag?: string;
          };

          // The code from the activation email is a human loop — a bogus
          // code must surface one of the operation's TYPED error tags,
          // proving the IAM grant and request wiring end-to-end.
          expect(response.activated).toBe(false);
          expect(["ValidationException", "ConflictException"]).toContain(
            response.errorTag,
          );
        }),
      { timeout: 120_000 },
    );
  });
});
