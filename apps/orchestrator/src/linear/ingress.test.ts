import { describe, expect, it } from "vitest";

import {
  containsLinearBotMention,
  linearThreadKeyFor,
  normalizeLinearWebhookInput,
} from "./ingress.ts";

describe("linear ingress normalization", () => {
  it("normalizes top-level comment mentions into adapter-compatible thread ids", () => {
    const ingress = normalizeLinearWebhookInput(
      {
        type: "Comment",
        action: "create",
        actor: {
          name: "Vivek",
          type: "user",
        },
        data: {
          id: "comment-9",
          issueId: "issue-123",
          body: "@Engineering please investigate this regression",
          createdAt: "2026-04-12T12:00:00.000Z",
          updatedAt: "2026-04-12T12:00:00.000Z",
          url: "https://linear.app/affil/issue/ENG-1/comment/comment-9",
        },
      },
      {
        botUserName: "Engineering",
      },
    );

    expect(ingress).not.toBeNull();
    expect(ingress?.threadKind).toBe("comment");
    expect(ingress?.commentId).toBe("comment-9");
    expect(ingress?.messageId).toBe("comment-9");
    expect(ingress?.linearThreadKey).toBe("linear:issue-123:c:comment-9");
    expect(ingress?.shouldStartRun).toBe(true);
  });

  it("threads replies under the root comment id", () => {
    const ingress = normalizeLinearWebhookInput({
      type: "Comment",
      action: "create",
      actor: {
        name: "Vivek",
        type: "user",
      },
      data: {
        id: "comment-10",
        issueId: "issue-123",
        parentId: "comment-9",
        body: "Following up in the same thread",
        createdAt: "2026-04-12T12:00:00.000Z",
        updatedAt: "2026-04-12T12:01:00.000Z",
      },
    });

    expect(ingress).not.toBeNull();
    expect(ingress?.commentId).toBe("comment-9");
    expect(ingress?.messageId).toBe("comment-10");
    expect(ingress?.linearThreadKey).toBe("linear:issue-123:c:comment-9");
    expect(ingress?.shouldStartRun).toBe(false);
  });

  it("ignores unsupported webhook resources instead of inventing a synthetic envelope", () => {
    const ingress = normalizeLinearWebhookInput({
      type: "Reaction",
      action: "create",
      data: {
        id: "reaction-1",
      },
    });

    expect(ingress).toBeNull();
  });

  it("documents the current attachment boundary via comment markdown only", () => {
    const ingress = normalizeLinearWebhookInput(
      {
        type: "Comment",
        action: "create",
        actor: {
          name: "Vivek",
          type: "user",
        },
        data: {
          id: "comment-11",
          issueId: "issue-123",
          body: "Attachment is linked here: https://uploads.linear.app/example.png",
          createdAt: "2026-04-12T12:00:00.000Z",
          updatedAt: "2026-04-12T12:00:00.000Z",
        },
      },
      {
        botUserName: "Engineering",
      },
    );

    expect(ingress?.body).toContain("https://uploads.linear.app/example.png");
    expect("attachments" in (ingress ?? {})).toBe(false);
  });
});

describe("linear mention detection", () => {
  it("matches case-insensitive plain-text mentions", () => {
    expect(containsLinearBotMention("@engineering can you help?", "Engineering")).toBe(true);
    expect(containsLinearBotMention("No mention here", "Engineering")).toBe(false);
  });

  it("keeps the helper compatible with issue-level ids when we need them later", () => {
    expect(linearThreadKeyFor({ issueId: "issue-123" })).toBe("linear:issue-123");
  });
});
