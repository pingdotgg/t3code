import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { threadDeepLink, parseThreadDeepLink } from "./threadDeepLinks.ts";
import { normalizeThreadClipboard } from "./composerContextClipboard.ts";
import {
  collectComposerContextReferences,
  threadContextRecord,
} from "./composerContextReferences.ts";
const ref = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread:1%2F") };

describe("public thread links", () => {
  it("round-trips encoded ids without losing literal escapes", () => {
    expect(parseThreadDeepLink(threadDeepLink(ref))).toEqual(ref);
    expect(parseThreadDeepLink("t3code://threads/env-1/thread%3A1%252F")).toEqual(ref);
  });
  it.each([
    "https://evil.test/env/thread",
    "https://app.t3.codes/settings/general",
    "https://app.t3.codes/projects/p",
    "https://app.t3.codes/draft/d",
    "t3code://threads/env/thread?token=secret",
    "https://app.t3.codes/env/%ZZ",
  ])("ignores unrelated or malformed URLs: %s", (value) => {
    expect(parseThreadDeepLink(value)).toBeNull();
  });
  it("turns plain URLs into cards without clipboard metadata", () => {
    const result = normalizeThreadClipboard("See " + threadDeepLink(ref), null);
    expect(result.fragment?.records).toEqual([threadContextRecord(ref, ref.threadId)]);
    expect(collectComposerContextReferences(result.text)).toHaveLength(1);
  });
  it("keeps copied titles and deduplicates repeated links", () => {
    const record = threadContextRecord(ref, "Fix login");
    const result = normalizeThreadClipboard(threadDeepLink(ref) + " " + threadDeepLink(ref), {
      version: 1,
      source: { environmentId: ref.environmentId },
      records: [record],
    });
    expect(result.fragment?.records).toEqual([record]);
    expect(collectComposerContextReferences(result.text).map((r) => r.label)).toEqual([
      "Fix login",
      "Fix login",
    ]);
  });
  it("leaves code examples literal and supports app links and Markdown wrappers", () => {
    const value = threadDeepLink(ref);
    const result = normalizeThreadClipboard(
      "`" + value + "` [Work](" + value + ") <t3code://threads/env-2/thread-2>",
      null,
    );
    expect(result.text.startsWith("`" + value + "`")).toBe(true);
    expect(collectComposerContextReferences(result.text).map((r) => r.label)).toEqual([
      "Work",
      "thread-2",
    ]);
  });
});

it("keeps identical thread ids on different machines distinct", () => {
  const result = normalizeThreadClipboard(
    "https://app.t3.codes/one/thread https://app.t3.codes/two/thread",
    null,
  );
  const records = result.fragment!.records;
  expect(records).toHaveLength(2);
  expect(new Set(records.map((record) => record.contextId)).size).toBe(2);
  expect(collectComposerContextReferences(result.text).map((record) => record.contextId)).toEqual(
    records.map((record) => record.contextId),
  );
});

it.each([
  "See https://app.t3.codes/env/thread.",
  "(https://app.t3.codes/env/thread)",
  "https://app.t3.codes/env/thread, then",
])("keeps punctuation outside thread IDs: %s", (text) => {
  const result = normalizeThreadClipboard(text, null);
  expect(result.fragment?.records).toMatchObject([{ threadId: "thread" }]);
  expect(result.text.endsWith(text.endsWith("then") ? ", then" : text.slice(-1))).toBe(true);
});
it.each([
  "https://example.com/?next=https://app.t3.codes/env/thread",
  "[ https://app.t3.codes/env/thread ](https://example.com)",
  "[Example](https://example.com/?next=https://app.t3.codes/env/thread)",
])("leaves foreign URLs and Markdown labels intact: %s", (text) => {
  expect(normalizeThreadClipboard(text, null)).toEqual({ text, fragment: null });
});
it.each([
  "[".repeat(80000) + " https://app.t3.codes/env/thread",
  '[{"a":1},'.repeat(125000) + " https://app.t3.codes/env/thread",
])("handles large bracket-heavy pastes", (text) => {
  const result = normalizeThreadClipboard(text, null);
  expect(result.text.startsWith(text.slice(0, 80000))).toBe(true);
  expect(result.fragment?.records).toMatchObject([{ environmentId: "env", threadId: "thread" }]);
  expect(collectComposerContextReferences(result.text)).toHaveLength(1);
});
it.each(["/assets/index.js", "/.well-known/assetlinks.json", "/guest/x", "/new/x"])(
  "rejects reserved web paths: %s",
  (path) => {
    expect(parseThreadDeepLink("https://app.t3.codes" + path)).toBeNull();
  },
);
