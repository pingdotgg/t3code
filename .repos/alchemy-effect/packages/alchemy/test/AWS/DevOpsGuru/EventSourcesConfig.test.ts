import * as AWS from "@/AWS";
import { EventSourcesConfig } from "@/AWS/DevOpsGuru/EventSourcesConfig.ts";
import * as Test from "@/Test/Alchemy";
import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Observe the account's event sources configuration out-of-band.
const observedProfilerStatus = devopsguru
  .describeEventSourcesConfig({})
  .pipe(
    Effect.map(
      ({ EventSources }) =>
        EventSources?.AmazonCodeGuruProfiler?.Status ?? "DISABLED",
    ),
  );

// Ungated typed probe: the describe call always answers with the config.
test.provider("describeEventSourcesConfig returns the configuration", () =>
  Effect.gen(function* () {
    const status = yield* observedProfilerStatus;
    expect(["ENABLED", "DISABLED"]).toContain(status);
  }),
);

// The configuration is an account/region singleton. Only run the destructive
// lifecycle when the account is at the default (disabled) — never clobber a
// configuration the user already operates.
test.provider(
  "lifecycle: enable CodeGuru Profiler event source, disable, destroy",
  (stack) =>
    Effect.gen(function* () {
      const preexisting = yield* observedProfilerStatus;
      if (preexisting === "ENABLED") {
        yield* Effect.logInfo(
          "CodeGuru Profiler event source already enabled — skipping destructive lifecycle test",
        );
        return;
      }

      yield* stack.destroy();

      // Create — enabled.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EventSourcesConfig("EventSources", {
            amazonCodeGuruProfiler: true,
          });
        }),
      );
      expect(created.amazonCodeGuruProfiler).toBe(true);
      expect(yield* observedProfilerStatus).toBe("ENABLED");

      // Update — back to disabled (converges in place).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EventSourcesConfig("EventSources", {
            amazonCodeGuruProfiler: false,
          });
        }),
      );
      expect(updated.amazonCodeGuruProfiler).toBe(false);
      expect(yield* observedProfilerStatus).toBe("DISABLED");

      // Re-enable so destroy has something to restore, then destroy.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EventSourcesConfig("EventSources", {
            amazonCodeGuruProfiler: true,
          });
        }),
      );
      yield* stack.destroy();
      expect(yield* observedProfilerStatus).toBe("DISABLED");
    }),
  { timeout: 180_000 },
);
