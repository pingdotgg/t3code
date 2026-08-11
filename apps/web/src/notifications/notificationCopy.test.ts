import { describe, expect, it } from "vite-plus/test";

import {
  notificationBody,
  notificationTitle,
  toPlainNotificationText,
  truncateNotificationBody,
} from "./notificationCopy";

describe("notificationTitle", () => {
  it("names what happened", () => {
    expect(notificationTitle("task-completed")).toBe("Completed");
    expect(notificationTitle("task-failed")).toBe("Failed");
    expect(notificationTitle("approval-needed")).toBe("Approval Required");
  });

  it("appends the project so several running agents stay distinguishable", () => {
    expect(notificationTitle("task-completed", "t3code")).toBe("Completed - t3code");
    expect(notificationTitle("task-failed", "api")).toBe("Failed - api");
    expect(notificationTitle("approval-needed", "web")).toBe("Approval Required - web");
  });

  it("omits an absent or blank project rather than leaving a dangling separator", () => {
    expect(notificationTitle("task-completed", null)).toBe("Completed");
    expect(notificationTitle("task-completed", "   ")).toBe("Completed");
    expect(notificationTitle("task-completed", undefined)).toBe("Completed");
  });

  it("shortens a long project name from the middle so both ends survive", () => {
    const title = notificationTitle("task-completed", "internal-platform-billing-service-monorepo");

    expect(title.startsWith("Completed - internal")).toBe(true);
    expect(title.endsWith("-monorepo")).toBe(true);
    expect(title).toContain("…");
  });
});

describe("toPlainNotificationText", () => {
  it("strips emphasis without eating the words", () => {
    expect(toPlainNotificationText("Fixed the **flaky** _auth_ test")).toBe(
      "Fixed the flaky auth test",
    );
    expect(toPlainNotificationText("__bold__ and ~~gone~~")).toBe("bold and gone");
  });

  it("unwraps inline code and links", () => {
    expect(toPlainNotificationText("Ran `pnpm test` in [the suite](https://example.com)")).toBe(
      "Ran pnpm test in the suite",
    );
    expect(toPlainNotificationText("![a diagram](img.png) follows")).toBe("a diagram follows");
  });

  it("replaces fenced code blocks with a marker", () => {
    expect(toPlainNotificationText("Before\n```ts\nconst x = 1;\n```\nAfter")).toBe(
      "Before (code) After",
    );
  });

  it("removes headings, quotes, and list markers", () => {
    expect(toPlainNotificationText("## Summary\n\n- one\n- two\n\n> quoted")).toBe(
      "Summary one two quoted",
    );
    expect(toPlainNotificationText("1. first\n2. second")).toBe("first second");
    expect(toPlainNotificationText("- [x] done\n- [ ] todo")).toBe("done todo");
  });

  it("drops html and horizontal rules", () => {
    expect(toPlainNotificationText("<b>bold</b> text<!-- hidden -->")).toBe("bold text");
    expect(toPlainNotificationText("above\n\n---\n\nbelow")).toBe("above below");
  });

  it("collapses newlines into a single flowing line", () => {
    expect(toPlainNotificationText("one\n\n\ntwo   three\n")).toBe("one two three");
  });

  it("leaves plain prose untouched", () => {
    expect(toPlainNotificationText("Just a normal sentence.")).toBe("Just a normal sentence.");
  });
});

describe("truncateNotificationBody", () => {
  it("passes short text through", () => {
    expect(truncateNotificationBody("short")).toBe("short");
  });

  it("truncates long text with an ellipsis", () => {
    const result = truncateNotificationBody("x".repeat(400));
    expect(result.length).toBeLessThanOrEqual(180);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("notificationBody", () => {
  it("prefers the response text", () => {
    expect(
      notificationBody({
        responseText: "## All set\n\nShipped it.",
        threadTitle: "Fix auth",
        fallbackHeadline: "Agent finished",
      }),
    ).toBe("All set Shipped it.");
  });

  it("falls back to the thread title when there is no response", () => {
    expect(
      notificationBody({
        responseText: null,
        threadTitle: "Fix auth",
        fallbackHeadline: "Agent finished",
      }),
    ).toBe("Fix auth");
  });

  it("falls back when the response flattens to nothing", () => {
    expect(
      notificationBody({
        responseText: "```\n\n```",
        threadTitle: "   ",
        fallbackHeadline: "Agent finished",
      }),
    ).toBe("(code)");
  });

  it("uses the headline when both response and title are empty", () => {
    expect(
      notificationBody({
        responseText: "   ",
        threadTitle: "   ",
        fallbackHeadline: "Agent finished",
      }),
    ).toBe("Agent finished");
  });
});
