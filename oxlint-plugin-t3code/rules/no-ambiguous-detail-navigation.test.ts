import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-ambiguous-detail-navigation", {
  filename: "apps/mobile/src/features/threads/ThreadFeed.tsx",
});

describe("t3code/no-ambiguous-detail-navigation", () => {
  rule.valid(
    "allows selections, explicit pushes, and other routes",
    `
      selectDetail({ name: "Thread", params });
      navigation.dispatch(StackActions.push("PullRequest", params));
      navigation.navigate("ThreadFiles", params);
    `,
  );

  rule.invalid("reports navigating to a thread", `navigation.navigate("Thread", params);`);

  rule.invalid(
    "reports a navigate action to a pull request",
    `navigation.dispatch(CommonActions.navigate("PullRequest", params));`,
  );
});
