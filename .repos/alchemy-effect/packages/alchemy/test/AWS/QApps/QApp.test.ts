import * as AWS from "@/AWS";
import { QApp } from "@/AWS/QApps";
import * as Test from "@/Test/Alchemy";
import * as qapps from "@distilled.cloud/aws/qapps";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Amazon Q Apps live inside an Amazon Q Business application environment
// (the `instance-id` header), which itself requires IAM Identity Center —
// neither is provisioned in the shared testing account. The ungated probe
// asserts the distilled wiring surfaces the typed error the provider's
// read/observe paths depend on; the full lifecycle is gated behind
// AWS_TEST_QAPPS=1 (an account with a Q Business application, passed as
// QAPPS_INSTANCE_ID).
describe("AWS.QApps.QApp", () => {
  // Without a Q Business instance, the API rejects at the door with a typed
  // UnauthorizedException ("Unauthorized") — the caller isn't an Identity
  // Center user of any instance. An entitled account with bogus ids surfaces
  // ResourceNotFoundException/AccessDeniedException instead; all three are
  // typed tags in the distilled union.
  test.provider(
    "getQApp against a nonexistent Q Business instance yields a typed error",
    (_stack) =>
      Effect.gen(function* () {
        const error = yield* qapps
          .getQApp({
            instanceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          })
          .pipe(Effect.flip);
        expect([
          "UnauthorizedException",
          "ResourceNotFoundException",
          "AccessDeniedException",
        ]).toContain(error._tag);
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "deleteQApp against a nonexistent Q Business instance yields a typed error",
    (_stack) =>
      Effect.gen(function* () {
        const error = yield* qapps
          .deleteQApp({
            instanceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          })
          .pipe(Effect.flip);
        expect([
          "UnauthorizedException",
          "ResourceNotFoundException",
          "AccessDeniedException",
        ]).toContain(error._tag);
      }),
    { timeout: 60_000 },
  );

  test.provider.skipIf(!process.env.AWS_TEST_QAPPS)(
    "create Q App, update definition, destroy, verify gone",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const instanceId = process.env.QAPPS_INSTANCE_ID;
        if (!instanceId) {
          return yield* Effect.die(
            new Error("AWS_TEST_QAPPS runs require QAPPS_INSTANCE_ID"),
          );
        }

        const textCardId = "11111111-1111-4111-8111-111111111111";
        const queryCardId = "22222222-2222-4222-8222-222222222222";

        const deploy = (props: { description?: string; prompt: string }) =>
          stack.deploy(
            Effect.gen(function* () {
              const app = yield* QApp("Summarizer", {
                instanceId,
                description: props.description,
                appDefinition: {
                  cards: [
                    {
                      textInput: {
                        id: textCardId,
                        title: "Source Text",
                        type: "text-input",
                      },
                    },
                    {
                      qQuery: {
                        id: queryCardId,
                        title: "Summary",
                        type: "q-query",
                        prompt: props.prompt,
                      },
                    },
                  ],
                },
                tags: { Environment: "test" },
              });
              return { app };
            }),
          );

        // Create.
        const { app } = yield* deploy({
          prompt: "Summarize the following text: @Source Text",
        });
        expect(app.appId).toBeDefined();
        expect(app.appArn).toContain(":qapps:");
        expect(app.status).toBeDefined();

        // Out-of-band verification via distilled.
        const observed = yield* qapps.getQApp({
          instanceId,
          appId: app.appId,
        });
        expect(observed.appId).toBe(app.appId);
        expect(observed.appDefinition.cards).toHaveLength(2);

        // Update in place — description + card prompt flow through UpdateQApp.
        const updated = yield* deploy({
          description: "updated by test",
          prompt: "Summarize the following text in one sentence: @Source Text",
        });
        expect(updated.app.appId).toBe(app.appId);
        const reobserved = yield* qapps.getQApp({
          instanceId,
          appId: app.appId,
        });
        expect(reobserved.description).toBe("updated by test");
        expect(reobserved.appVersion).toBeGreaterThan(observed.appVersion);

        yield* stack.destroy();

        // Typed wait-until-gone.
        yield* Effect.gen(function* () {
          const gone = yield* qapps
            .getQApp({ instanceId, appId: app.appId })
            .pipe(
              Effect.map((d) => d.status === "DELETED"),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(true),
              ),
            );
          if (!gone) {
            return yield* Effect.fail({ _tag: "StillExists" as const });
          }
        }).pipe(
          Effect.retry({
            while: (e: { _tag: string }) => e._tag === "StillExists",
            schedule: Schedule.max([
              Schedule.spaced("5 seconds"),
              Schedule.recurs(10),
            ]),
          }),
        );
      }),
    { timeout: 600_000 },
  );
});
