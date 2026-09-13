import {
  MESSAGE_ARTIFACT_MAX_COUNT,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2MessageArtifact,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  findMessageArtifactFences,
  preserveMessageArtifacts,
  recordMessageArtifacts,
} from "./messageArtifacts.ts";

const fence = (path: string, info = "t3-artifact") => `\`\`\`${info}\n${path}\n\`\`\``;

describe("findMessageArtifactFences", () => {
  it("finds artifact fences in source order with the range each one covers", () => {
    const markdown = ["Intro", fence("charts/a.html"), "Between", fence("b.htm")].join("\n");
    const fences = findMessageArtifactFences(markdown);

    expect(fences.map(({ path, sourceOrdinal }) => ({ path, sourceOrdinal }))).toEqual([
      { path: "charts/a.html", sourceOrdinal: 0 },
      { path: "b.htm", sourceOrdinal: 1 },
    ]);
    expect(markdown.slice(fences[0]!.start, fences[0]!.end)).toBe(fence("charts/a.html"));
  });

  it("reads CRLF text and tilde fences", () => {
    expect(
      findMessageArtifactFences("Intro\r\n~~~t3-artifact\r\na.html\r\n~~~\r\n").map(
        (found) => found.path,
      ),
    ).toEqual(["a.html"]);
  });

  it("gives a repeated path one ordinal per fence", () => {
    expect(
      findMessageArtifactFences(`${fence("same.html")}\n${fence("same.html")}`).map(
        (found) => found.sourceOrdinal,
      ),
    ).toEqual([0, 1]);
  });

  it("leaves fences inside another fence or a list item as code", () => {
    expect(findMessageArtifactFences(`\`\`\`\`md\n${fence("a.html")}\n\`\`\`\``)).toEqual([]);
    expect(findMessageArtifactFences("- item\n  ```t3-artifact\n  a.html\n  ```")).toEqual([]);
  });

  it("accepts text after the fence language", () => {
    expect(findMessageArtifactFences(fence("a.html", 't3-artifact title="Chart"'))).toHaveLength(1);
  });

  it("keeps at most the contract's artifact count", () => {
    const markdown = Array.from({ length: MESSAGE_ARTIFACT_MAX_COUNT + 2 }, (_, index) =>
      fence(`${index}.html`),
    ).join("\n");
    expect(findMessageArtifactFences(markdown)).toHaveLength(MESSAGE_ARTIFACT_MAX_COUNT);
  });

  it.each([
    "https://example.com/a.html",
    "/tmp/a.html",
    "C:\\temp\\a.html",
    "\\\\server\\share\\a.html",
    "charts/../secret.html",
    "a.html#today",
    "a.js",
    "one.html\ntwo.html",
  ])("rejects a path that is not a workspace-relative HTML file: %s", (path) => {
    expect(findMessageArtifactFences(fence(path))).toEqual([]);
  });

  it("does not treat an unclosed fence as an artifact", () => {
    expect(findMessageArtifactFences("```t3-artifact\na.html")).toEqual([]);
  });
});

const copy = (sourceOrdinal: number, sourcePath: string, attachmentId: string) =>
  ({ sourceOrdinal, sourcePath, attachmentId }) satisfies OrchestrationV2MessageArtifact;

describe("preserveMessageArtifacts", () => {
  const recorded = [copy(0, "a.html", "a")];

  it("keeps recorded copies, unchanged, when a re-published payload omits them", () => {
    const next = { text: [fence("b.html"), fence("a.html")].join("\n") };
    expect(preserveMessageArtifacts({ artifacts: recorded }, next)).toEqual({
      ...next,
      artifacts: recorded,
    });
  });

  it("leaves a payload that carries its own copies, or has nothing to keep, alone", () => {
    const next = { text: fence("a.html"), artifacts: [copy(0, "a.html", "b")] };
    expect(preserveMessageArtifacts({ artifacts: recorded }, next)).toBe(next);
    const plain = { text: "no copies" };
    expect(preserveMessageArtifacts(undefined, plain)).toBe(plain);
    expect(preserveMessageArtifacts({ text: "old" }, plain)).toBe(plain);
  });
});

describe("recordMessageArtifacts", () => {
  const now = DateTime.makeUnsafe("2026-09-10T12:00:00.000Z");
  const threadId = ThreadId.make("thread:record");
  const messageId = MessageId.make("message:record");
  const text = fence("chart.html");
  const message: OrchestrationV2ConversationMessage = {
    createdBy: "agent",
    creationSource: "provider",
    id: messageId,
    threadId,
    runId: null,
    nodeId: null,
    role: "assistant",
    text,
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
  };
  const item = (id: string, forMessage: MessageId): OrchestrationV2TurnItem => ({
    id: TurnItemId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "assistant_message",
    messageId: forMessage,
    text,
    streaming: false,
  });

  it("replaces the copies of the message and every item that shows it", () => {
    const shown = { ...item("item:shown", messageId), artifacts: [copy(0, "stale.html", "old")] };
    const other = item("item:other", MessageId.make("message:other"));
    const projection = {
      messages: [message],
      turnItems: [shown, other],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local" as const,
          sourceThreadId: threadId,
          sourceItemId: shown.id,
          item: shown,
        },
      ],
    };

    const next = recordMessageArtifacts(projection, messageId, [copy(0, "chart.html", "a")]);

    expect(next.messages[0]?.artifacts).toEqual([copy(0, "chart.html", "a")]);
    expect(next.turnItems[0]).toMatchObject({ artifacts: [copy(0, "chart.html", "a")] });
    expect(next.turnItems[1]).toBe(other);
    expect(next.visibleTurnItems[0]?.item).toEqual(next.turnItems[0]);
  });
});
