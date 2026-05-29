import { describe, expect, it } from "vitest";

import {
  flattenMarkdownTablesForSlack,
  postablePullRequestMerged,
  postableReplyBody,
  postableTaskStartedStatus,
  protectSlackPackageScopes,
} from "./postableReply.ts";

describe("postableReplyBody", () => {
  it("posts Slack replies as Markdown so the Slack adapter converts formatting", () => {
    expect(
      postableReplyBody({
        kind: "slack_thread",
        body: "**Dependencies**\n\n- `react`\n- `vite`",
      }),
    ).toEqual({
      markdown: "**Dependencies**\n\n- `react`\n- `vite`",
    });
  });

  it("flattens Markdown tables before Slack can drop cell formatting", () => {
    expect(
      flattenMarkdownTablesForSlack(
        [
          "| Package | Purpose |",
          "| --- | --- |",
          "| **apps/web** | `next`, **React** |",
          "| **packages/db** | Database helpers |",
        ].join("\n"),
      ),
    ).toBe(
      [
        "- **apps/web:** **Purpose:** `next`, **React**",
        "- **packages/db:** **Purpose:** Database helpers",
      ].join("\n"),
    );
  });

  it("protects scoped package names from Slack mention expansion", () => {
    expect(
      protectSlackPackageScopes("Uses @sentry/nextjs, @vercel/*, and `@repo/ui` packages."),
    ).toBe("Uses `@sentry/nextjs`, `@vercel/*`, and `@repo/ui` packages.");
  });
});

describe("postableTaskStartedStatus", () => {
  it("builds a Slack task started card with an Open T3 button", () => {
    const message = postableTaskStartedStatus({
      kind: "slack_thread",
      t3ThreadUrl: "https://t3.example.com/environment-local/thread-123",
    });

    expect(message).toMatchObject({
      fallbackText: expect.stringContaining("Open T3"),
      card: {
        title: "Talk to Vevin in this thread",
      },
    });
    expect(JSON.stringify(message)).toContain(
      "https://t3.example.com/environment-local/thread-123",
    );
  });
});

describe("postablePullRequestMerged", () => {
  it("builds a Slack PR merged card with a View PR button", () => {
    const message = postablePullRequestMerged({
      kind: "slack_thread",
      pullRequestUrl: "https://github.com/acme/app/pull/42",
      title: "Add checkout filter",
    });

    expect(message).toMatchObject({
      fallbackText: "PR was merged: https://github.com/acme/app/pull/42",
      card: {
        title: "PR was merged #42 - Add checkout filter",
      },
    });
    expect(JSON.stringify(message)).toContain("View PR");
    expect(JSON.stringify(message)).not.toContain("New PR");
  });
});
