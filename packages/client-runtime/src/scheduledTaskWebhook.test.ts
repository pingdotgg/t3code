import { describe, expect, it } from "vite-plus/test";

import {
  parseMaxDeliveryAge,
  emptyWebhookFilterDraft,
  parseWebhookFilterDrafts,
  removeWebhookFilterDraft,
  webhookFilterDrafts,
  webhookFilterDraftsChanged,
} from "./scheduledTaskWebhook.ts";

describe("parseMaxDeliveryAge", () => {
  it("treats blank as no limit and rejects values the server would not accept", () => {
    expect(parseMaxDeliveryAge("")).toBeNull();
    expect(parseMaxDeliveryAge(" 45 ")).toBe(45);
    for (const invalid of ["0", "1.5", "-3", "abc", "1441"]) {
      expect(parseMaxDeliveryAge(invalid)).toBeUndefined();
    }
  });
});

describe("webhook filter drafts", () => {
  it("round-trips saved filters through the form rows", () => {
    const filters = [
      { path: "headers.x-github-event", op: "equals", value: "pull_request" },
      { path: "body.action", op: "in", value: ["opened", "reopened"] },
      { path: "body.label.name", op: "in", value: ["needs review", "a-b"] },
      { path: "query.source", op: "exists" },
    ] as const;
    const drafts = webhookFilterDrafts(filters);
    expect(drafts[1]).toMatchObject({ path: "body.action", op: "in", value: "opened, reopened" });
    expect(parseWebhookFilterDrafts(drafts)).toEqual({ filters });
  });

  it("names the first row the server would refuse", () => {
    expect(
      parseWebhookFilterDrafts([
        { id: "f1", path: "body.action", op: "equals", value: "opened" },
        { id: "f2", path: "body.action", op: "in", value: " , " },
        { id: "f3", path: "", op: "exists", value: "" },
      ]),
    ).toEqual({
      error: "Filter 2 needs a path under body, headers or query, and at least one value.",
    });
    expect(parseWebhookFilterDrafts([{ id: "f1", path: " ", op: "exists", value: "" }])).toEqual({
      error: "Filter 1 needs a path under body, headers or query.",
    });
    const seventeen = Array.from({ length: 17 }, (_, index) => ({
      id: `f${index}`,
      path: "body.action",
      op: "exists" as const,
      value: "",
    }));
    expect(parseWebhookFilterDrafts(seventeen)).toEqual({ error: "Use at most 16 filters." });
  });

  it("notices added, removed and edited rows but not an untouched list", () => {
    const saved = webhookFilterDrafts([{ path: "body.action", op: "equals", value: "opened" }]);
    expect(webhookFilterDraftsChanged(saved, [...saved])).toBe(false);
    expect(webhookFilterDraftsChanged(saved, [])).toBe(true);
    expect(webhookFilterDraftsChanged(saved, [{ ...saved[0]!, value: "closed" }])).toBe(true);
    expect(webhookFilterDraftsChanged([], [])).toBe(false);
  });

  it("removing the first row keeps the second row's id", () => {
    const drafts = [
      ...webhookFilterDrafts([{ path: "body.action", op: "equals", value: "opened" }]),
      emptyWebhookFilterDraft(),
    ];
    expect(new Set(drafts.map((draft) => draft.id)).size).toBe(2);
    const remaining = removeWebhookFilterDraft(drafts, drafts[0]!.id);
    expect(remaining.map((draft) => draft.id)).toEqual([drafts[1]!.id]);
  });
});
