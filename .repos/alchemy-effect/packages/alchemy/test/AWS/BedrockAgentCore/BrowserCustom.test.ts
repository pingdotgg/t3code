import * as AWS from "@/AWS";
import { BrowserCustom } from "@/AWS/BedrockAgentCore";
import * as Test from "@/Test/Alchemy";
import * as control from "@distilled.cloud/aws/bedrock-agentcore-control";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe.
test.provider(
  "getBrowser on a nonexistent id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        control.getBrowser({
          browserId: "alchemy_nonexistent_probe-0000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const assertBrowserGone = (browserId: string) =>
  Effect.gen(function* () {
    const status = yield* control.getBrowser({ browserId }).pipe(
      Effect.map((r) => r.status as string),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("DELETED" as string),
      ),
    );
    if (status !== "DELETED") {
      return yield* Effect.fail(
        new Error(`browser still live (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create custom browser, verify out-of-band, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { browser } = yield* stack.deploy(
        Effect.gen(function* () {
          const browser = yield* BrowserCustom("AgentBrowser", {
            description: "alchemy agentcore browser test",
            tags: { fixture: "agentcore-browser" },
          });
          return { browser };
        }),
      );

      expect(browser.browserId).toBeTruthy();
      expect(browser.browserArn).toContain(":browser");
      expect(browser.status).toBe("READY");

      const observed = yield* control.getBrowser({
        browserId: browser.browserId,
      });
      expect(observed.status).toBe("READY");
      expect(observed.networkConfiguration.networkMode).toBe("PUBLIC");

      // tags observed on the resource
      const tags = yield* control.listTagsForResource({
        resourceArn: browser.browserArn,
      });
      expect(tags.tags?.fixture).toBe("agentcore-browser");
      expect(tags.tags?.["alchemy::id"]).toBe("AgentBrowser");

      yield* stack.destroy();
      yield* assertBrowserGone(browser.browserId);
    }),
  { timeout: 120_000 },
);
