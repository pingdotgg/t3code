import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  COMPOSER_CONTEXT_KINDS,
  ComposerContextRecord,
  OrchestrationMessageContext,
} from "./composerContext.ts";
import {
  OrchestrationV2Command,
  OrchestrationV2ConversationMessageJson,
} from "./orchestrationV2.ts";

const decodeRecord = Schema.decodeUnknownOption(ComposerContextRecord);
const decodeContext = Schema.decodeUnknownSync(OrchestrationMessageContext);
const decodeMessage = Schema.decodeUnknownSync(OrchestrationV2ConversationMessageJson);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);

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
  thread: {
    ...base,
    kind: "thread",
    label: "Fix login flow",
    environmentId: "environment-1",
    threadId: "thread-1",
    title: "Fix login flow",
  },
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

  it("sends a message without a record it cannot encode", () => {
    const wire = Schema.encodeUnknownSync(Schema.toCodecJson(OrchestrationMessageContext))({
      version: 1,
      records: [
        decodeContext({ version: 1, records: [knownRecords.terminal] }).records[0],
        { ...knownRecords.terminal, contextId: "ctx_2", terminalLabel: "   " },
      ],
    });
    expect(decodeContext(wire).records.map((record) => record.contextId)).toEqual(["ctx_1"]);
  });

  it("sends a message without the records the wire cannot carry", () => {
    const wire = Schema.encodeUnknownSync(Schema.toCodecJson(OrchestrationMessageContext))({
      version: 1,
      records: [
        decodeContext({ version: 1, records: [knownRecords.terminal] }).records[0],
        {
          ...base,
          contextId: "ctx_2",
          kind: "future-kind",
          label: "x",
          payload: { count: Number.NaN },
        },
        { ...knownRecords["review-comment"], contextId: "ctx_3", fenceLanguage: undefined },
        // JSON.stringify throws on a bigint on every engine.
        { ...base, contextId: "ctx_4", kind: "future-kind", label: "y", payload: { n: 1n } },
      ],
    });
    expect(decodeContext(wire).records.map((record) => record.contextId)).toEqual(["ctx_1"]);
  });

  it("reports a hole as a schema issue, even when collecting every issue", () => {
    const result = Schema.decodeUnknownExit(Schema.toType(OrchestrationMessageContext))(
      { version: 1, records: [undefined] },
      { errors: "all" },
    );
    expect(Exit.isFailure(result) && Cause.hasFails(result.cause)).toBe(true);
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

  it("is optional on messages and message dispatch commands", () => {
    const message = {
      createdBy: "user",
      creationSource: "web",
      id: "m1",
      threadId: "t1",
      runId: null,
      nodeId: null,
      role: "user",
      text: "hi",
      attachments: [],
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

    const command = decodeCommand({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: "c1",
      threadId: "t1",
      messageId: "m1",
      text: "hi",
      attachments: [],
      context: { version: 1, records: [knownRecords.image] },
      dispatchMode: { type: "start_immediately" },
    });
    expect(command.type === "message.dispatch" && command.context?.records[0]?.kind).toBe("image");
  });
});
