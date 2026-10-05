import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  cci.getProjectsLocationsPhraseMatchers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const refundGroups = [
  {
    type: "ANY_OF" as const,
    phraseMatchRules: [
      {
        query: "refund",
        config: { exactMatchConfig: { caseSensitive: false } },
      },
    ],
  },
];

const cancelGroups = [
  {
    type: "ANY_OF" as const,
    phraseMatchRules: [
      {
        query: "cancel",
        config: { exactMatchConfig: { caseSensitive: false } },
      },
    ],
  },
];

test.provider(
  "getProjectsLocationsPhraseMatchers on a missing matcher fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsPhraseMatchers({
          name: `projects/${project}/locations/us-central1/phraseMatchers/9876543210`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a phrase matcher",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.PhraseMatcher("Refunds", {
            location: "us-central1",
            displayName: "refunds",
            type: "ALL_OF",
            active: false,
            phraseMatchRuleGroups: refundGroups,
          });
        }),
      );

      expect(created.name).toContain("/phraseMatchers/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("refunds");
      expect(created.type).toEqual("ALL_OF");
      expect(created.active).toEqual(false);

      const fetched = yield* cci.getProjectsLocationsPhraseMatchers({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.displayName).toContain("refunds");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.PhraseMatcher("Refunds", {
            phraseMatcherId: created.phraseMatcherId,
            location: "us-central1",
            displayName: "cancellations",
            type: "ALL_OF",
            active: false,
            phraseMatchRuleGroups: cancelGroups,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("cancellations");
      expect(
        updated.phraseMatchRuleGroups?.[0]?.phraseMatchRules?.[0]?.query,
      ).toEqual("cancel");

      const fetchedUpdate = yield* cci.getProjectsLocationsPhraseMatchers({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toContain("cancellations");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 90_000,
  },
);
