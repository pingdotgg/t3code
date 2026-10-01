import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  COMPOSER_CONTEXT_KINDS,
  ComposerContextRecord,
  OrchestrationMessageContext,
} from "./composerContext.ts";
import { OrchestrationMessage, ThreadTurnStartCommand } from "./orchestration.ts";

const decodeRecord = Schema.decodeUnknownOption(ComposerContextRecord);
const decodeContext = Schema.decodeUnknownSync(OrchestrationMessageContext);
const decodeMessage = Schema.decodeUnknownSync(OrchestrationMessage);
const decodeTurnStart = Schema.decodeUnknownSync(ThreadTurnStartCommand);

const base = { version: 1, contextId: "ctx_1" } as const;

const knownRecords: Record<(typeof COMPOSER_CONTEXT_KINDS)[number], Record<string, unknown>> = {
  image: {
    ...base,
    kind: "image",
    label: "checkout-error.png",
    attachmentId: "att_1",
    name: "checkout-error.png",
    mimeType: "image/png",
    sizeBytes: 1234,
  },
  file: {
    ...base,
    kind: "file",
    label: "notes.txt",
    attachmentId: "att_2",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
  },
  terminal: {
    ...base,
    kind: "terminal",
    label: "Terminal 1 lines 509-514",
    terminalId: "term-1",
    terminalLabel: "Terminal 1",
    lineStart: 509,
    lineEnd: 514,
    text: "error: boom\n  at main.ts:1",
  },
  element: {
    ...base,
    kind: "element",
    label: "<Button>",
    pageUrl: "http://localhost:3000/checkout",
    pageTitle: "Checkout",
    tagName: "button",
    selector: "#pay",
    htmlPreview: '<button id="pay">Pay</button>',
    componentName: "Button",
    source: { functionName: "Button", fileName: "Button.tsx", lineNumber: 12, columnNumber: 3 },
    styles: "color: red;",
  },
  "preview-annotation": {
    ...base,
    kind: "preview-annotation",
    label: "Checkout",
    annotationId: "ann_1",
    pageUrl: "http://localhost:3000/checkout",
    pageTitle: "Checkout",
    comment: "Make this bigger",
    targetSummary: "1 selected element",
    styleChanges: ["font-size: 20px"],
    elements: [
      {
        pageUrl: "http://localhost:3000/checkout",
        pageTitle: "Checkout",
        tagName: "button",
        selector: "#pay",
        htmlPreview: "<button>Pay</button>",
        componentName: "Button",
        source: null,
        styles: "",
      },
    ],
    screenshotContextId: "ctx_2",
  },
  "review-comment": {
    ...base,
    kind: "review-comment",
    label: "ChatComposer.tsx L4118",
    sectionId: "diff-1",
    sectionTitle: "Changes",
    filePath: "apps/web/src/ChatComposer.tsx",
    startIndex: 4118,
    endIndex: 4118,
    rangeLabel: "L4118",
    text: "Why is this here?",
    diff: "+ const x = 1;",
    fenceLanguage: "diff",
    pullRequest: {
      number: 42,
      title: "Improve context chips",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      headBranch: "feat/context-chips",
      baseBranch: "main",
      state: "open",
      isDraft: false,
    },
  },
  mention: { ...base, kind: "mention", label: "@src/index.ts", path: "src/index.ts" },
  skill: { ...base, kind: "skill", label: "$pinchtab", name: "pinchtab" },
};

describe("ComposerContextRecord", () => {
  it.each(COMPOSER_CONTEXT_KINDS)("round-trips a %s record", (kind) => {
    const decoded = decodeRecord(knownRecords[kind]);
    expect(Option.isSome(decoded)).toBe(true);
    expect(Option.getOrThrow(decoded)).toEqual(knownRecords[kind]);
  });

  it("keeps unknown kinds with their payload", () => {
    const decoded = decodeRecord({
      ...base,
      kind: "future-thing",
      label: "Future",
      payload: { anything: [1, 2, 3] },
    });
    expect(Option.getOrThrow(decoded)).toEqual({
      version: 1,
      contextId: "ctx_1",
      kind: "future-thing",
      label: "Future",
      payload: { anything: [1, 2, 3] },
    });
  });

  it("does not let a malformed known kind slide through as unknown", () => {
    expect(Option.isNone(decodeRecord({ ...base, kind: "image", label: "x" }))).toBe(true);
  });

  it("bounds the serialized payload of future context kinds", () => {
    const unknown = { ...base, kind: "future-thing", label: "Future" };
    expect(Option.isSome(decodeRecord({ ...unknown, payload: "x".repeat(63_998) }))).toBe(true);
    expect(Option.isNone(decodeRecord({ ...unknown, payload: "x".repeat(63_999) }))).toBe(true);
    expect(Option.isNone(decodeRecord({ ...unknown, payload: '"'.repeat(32_000) }))).toBe(true);
    expect(
      decodeContext({
        version: 1,
        records: [
          { ...unknown, payload: "x".repeat(64_000) },
          { ...knownRecords.skill, contextId: "ctx_skill" },
        ],
      }).records,
    ).toEqual([{ ...knownRecords.skill, contextId: "ctx_skill" }]);
  });

  it("rejects bad ids and versions", () => {
    expect(Option.isNone(decodeRecord({ ...knownRecords.skill, contextId: "has space" }))).toBe(
      true,
    );
    expect(Option.isNone(decodeRecord({ ...knownRecords.skill, version: 2 }))).toBe(true);
    expect(Option.isNone(decodeRecord({ ...knownRecords.skill, kind: "Bad Kind" }))).toBe(true);
  });
});

describe("OrchestrationMessageContext", () => {
  it("rejects aggregate context size even when each record is valid", () => {
    const record = {
      ...knownRecords["preview-annotation"],
      styleChangeDetails: Array.from({ length: 200 }, () => ({
        targetId: "target",
        selector: null,
        property: "content",
        previousValue: "x".repeat(8_000),
        value: "y".repeat(8_000),
      })),
    };
    expect(Option.isSome(decodeRecord(record))).toBe(true);
    expect(() => decodeContext({ version: 1, records: [record] })).not.toThrow();
    expect(() =>
      decodeContext({
        version: 1,
        records: Array.from({ length: 6 }, (_, index) => ({
          ...record,
          contextId: `ctx_${index}`,
        })),
      }),
    ).toThrow();
  });

  it("normalizes decoded record identifiers", () => {
    const context = decodeContext({
      version: 1,
      records: [{ ...knownRecords.skill, contextId: "  ctx_1  ", name: "  review  " }],
    });
    expect(context.records[0]).toMatchObject({ contextId: "ctx_1", name: "review" });
  });

  it("rejects oversized arrays before dropping malformed records", () => {
    expect(() =>
      decodeContext({ version: 1, records: Array.from({ length: 201 }, () => ({})) }),
    ).toThrow();
  });

  it("drops undecodable records and keeps valid siblings", () => {
    const context = decodeContext({
      version: 1,
      records: [
        knownRecords.skill,
        { version: 1, kind: "image" },
        { ...knownRecords.terminal, contextId: "ctx_2" },
      ],
    });
    expect(context.records.map((record) => record.kind)).toEqual(["skill", "terminal"]);
  });

  it("rejects duplicate normalized context identities", () => {
    expect(() =>
      decodeContext({
        version: 1,
        records: [knownRecords.skill, { ...knownRecords.terminal, contextId: " ctx_1 " }],
      }),
    ).toThrow();
  });

  it("is optional on messages and turn-start commands", () => {
    const message = {
      id: "m1",
      role: "user",
      text: "hi",
      turnId: null,
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(decodeMessage(message).context).toBeUndefined();
    const withContext = decodeMessage({
      ...message,
      context: { version: 1, records: [knownRecords.mention] },
    });
    expect(withContext.context?.records).toHaveLength(1);

    const command = decodeTurnStart({
      type: "thread.turn.start",
      commandId: "c1",
      threadId: "t1",
      message: {
        messageId: "m1",
        role: "user",
        text: "hi",
        attachments: [],
        context: { version: 1, records: [knownRecords.image] },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(command.message.context?.records[0]?.kind).toBe("image");
  });
});
