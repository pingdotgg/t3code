import { describe, expect, it } from "vite-plus/test";
import { mFallback } from "gt-i18n";
import { MAX_WEBHOOK_DELIVERY_AGE_MINUTES, MAX_WEBHOOK_FILTERS } from "@t3tools/contracts";

import {
  emptyWebhookFilterDraft,
  parseMaxDeliveryAge,
  parseWebhookFilterDrafts,
  removeWebhookFilterDraft,
  webhookFilterDrafts,
  webhookFilterDraftsChanged,
  type WebhookFilterDraft,
} from "./scheduledTaskWebhook.ts";

const draft = (path: string, op: WebhookFilterDraft["op"], value = ""): WebhookFilterDraft => ({
  id: `d-${path}-${op}`,
  path,
  op,
  value,
});

describe("parseMaxDeliveryAge", () => {
  it("treats blank input as no limit", () => {
    expect(parseMaxDeliveryAge("")).toBeNull();
    expect(parseMaxDeliveryAge("   ")).toBeNull();
  });

  it("rejects non-integer, non-positive, and over-max values", () => {
    expect(parseMaxDeliveryAge("abc")).toBeUndefined();
    expect(parseMaxDeliveryAge("0")).toBeUndefined();
    expect(parseMaxDeliveryAge("-5")).toBeUndefined();
    expect(parseMaxDeliveryAge("1.5")).toBeUndefined();
    expect(parseMaxDeliveryAge(String(MAX_WEBHOOK_DELIVERY_AGE_MINUTES + 1))).toBeUndefined();
  });

  it("accepts a valid minute count", () => {
    expect(parseMaxDeliveryAge("60")).toBe(60);
    expect(parseMaxDeliveryAge(String(MAX_WEBHOOK_DELIVERY_AGE_MINUTES))).toBe(
      MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
    );
  });
});

describe("parseWebhookFilterDrafts", () => {
  it("parses each op into the filter shape the server schema expects", () => {
    const result = parseWebhookFilterDrafts(
      [
        draft("body.action", "equals", "opened"),
        draft("headers.x-event", "notEquals", "ping"),
        draft("body.ref", "startsWith", "refs/heads/"),
        draft("body.sender.login", "in", "alice, bob"),
        draft("query.sig", "exists"),
      ],
      mFallback,
    );
    expect(result).toEqual({
      filters: [
        { path: "body.action", op: "equals", value: "opened" },
        { path: "headers.x-event", op: "notEquals", value: "ping" },
        { path: "body.ref", op: "startsWith", value: "refs/heads/" },
        { path: "body.sender.login", op: "in", value: ["alice", "bob"] },
        { path: "query.sig", op: "exists" },
      ],
    });
  });

  it("trims the path and splits the in list on commas, dropping empties", () => {
    const result = parseWebhookFilterDrafts(
      [draft("  body.action  ", "in", " alice ,, bob ,")],
      mFallback,
    );
    expect(result).toEqual({
      filters: [{ path: "body.action", op: "in", value: ["alice", "bob"] }],
    });
  });

  it("rejects a path outside body, headers, or query and names the row", () => {
    const result = parseWebhookFilterDrafts(
      [draft("body.ok", "equals", "x"), draft("meta.bad", "equals", "x")],
      mFallback,
    );
    expect(result).toEqual({
      error: "Filter 2 needs a path under body, headers or query, and a value.",
    });
  });

  it("rejects an in row whose list has no values", () => {
    const result = parseWebhookFilterDrafts([draft("body.action", "in", " , ,")], mFallback);
    expect(result).toEqual({
      error: "Filter 1 needs a path under body, headers or query, and at least one value.",
    });
  });

  it("rejects an exists row with a bad path using its own message", () => {
    const result = parseWebhookFilterDrafts([draft("nope", "exists")], mFallback);
    expect(result).toEqual({
      error: "Filter 1 needs a path under body, headers or query.",
    });
  });

  it("rejects more filters than the server allows", () => {
    const result = parseWebhookFilterDrafts(
      Array.from({ length: MAX_WEBHOOK_FILTERS + 1 }, () => draft("body.action", "equals", "x")),
      mFallback,
    );
    expect(result).toEqual({
      error: `Use at most ${MAX_WEBHOOK_FILTERS} filters.`,
    });
  });
});

describe("webhookFilterDrafts", () => {
  it("round-trips stored filters into editable drafts", () => {
    const drafts = webhookFilterDrafts([
      { path: "body.action", op: "equals", value: "opened" },
      { path: "body.sender", op: "in", value: ["a", "b"] },
      { path: "query.sig", op: "exists" },
    ]);
    expect(drafts.map((d) => [d.path, d.op, d.value])).toEqual([
      ["body.action", "equals", "opened"],
      ["body.sender", "in", "a, b"],
      ["query.sig", "exists", ""],
    ]);
    // And the drafts parse back to the same filters.
    const parsed = parseWebhookFilterDrafts(drafts, mFallback);
    expect(parsed).toEqual({
      filters: [
        { path: "body.action", op: "equals", value: "opened" },
        { path: "body.sender", op: "in", value: ["a", "b"] },
        { path: "query.sig", op: "exists" },
      ],
    });
  });
});

describe("webhookFilterDraftsChanged", () => {
  const saved = [draft("body.action", "equals", "opened"), draft("query.sig", "exists", "ignored")];

  it("is unchanged when only row order and content match", () => {
    expect(
      webhookFilterDraftsChanged(saved, [
        draft("body.action", "equals", "opened"),
        draft("query.sig", "exists", "different"),
      ]),
    ).toBe(false);
  });

  it("detects length, path, op, and value changes", () => {
    expect(webhookFilterDraftsChanged(saved, saved.slice(0, 1))).toBe(true);
    expect(
      webhookFilterDraftsChanged(saved, [
        draft("body.other", "equals", "opened"),
        draft("query.sig", "exists"),
      ]),
    ).toBe(true);
    expect(
      webhookFilterDraftsChanged(saved, [
        draft("body.action", "notEquals", "opened"),
        draft("query.sig", "exists"),
      ]),
    ).toBe(true);
    expect(
      webhookFilterDraftsChanged(saved, [
        draft("body.action", "equals", "closed"),
        draft("query.sig", "exists"),
      ]),
    ).toBe(true);
  });
});

describe("draft row identity", () => {
  it("removes a row by id and gives each new row a fresh id", () => {
    const a = emptyWebhookFilterDraft();
    const b = emptyWebhookFilterDraft();
    expect(a.id).not.toBe(b.id);
    expect(removeWebhookFilterDraft([a, b], a.id)).toEqual([b]);
    expect(removeWebhookFilterDraft([a, b], "missing")).toEqual([a, b]);
  });
});
