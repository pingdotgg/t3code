import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { buildProjectThreadStartTurnInput } from "./projectThreadStartTurn";
import {
  ProjectId,
  ProviderInstanceId,
  ComposerContextId,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  projectComposerContextForProvider,
} from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";
import {
  composerContextEditorTokens,
  composerContextSendBlockReason,
  composerMentionPath,
  createComposerContextHistory,
  referencedComposerContext,
  reidentifyComposerContext,
  uploadedComposerContext,
  serializeComposerMessageForServer,
  pullRequestComposerContext,
} from "./composerContext";

const terminal = {
  version: 1 as const,
  kind: "terminal" as const,
  contextId: ComposerContextId.make("terminal-1"),
  label: "Build output",
  terminalId: "main",
  terminalLabel: "Terminal",
  lineStart: 4,
  lineEnd: 5,
  text: "build failed\nretry",
};
const image = {
  version: 1 as const,
  kind: "image" as const,
  contextId: ComposerContextId.make("image-1"),
  label: "Screenshot",
  attachmentId: "local-image",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 123,
};
const annotation = {
  version: 1 as const,
  kind: "preview-annotation" as const,
  contextId: ComposerContextId.make("preview-1"),
  label: "Button",
  annotationId: "button-1",
  pageUrl: "https://example.com",
  pageTitle: null,
  comment: "Keep the cart",
  targetSummary: "Button",
  styleChanges: [],
  screenshotContextId: image.contextId,
};

describe("mobile composer context", () => {
  it("rejects a malformed record instead of allowing the wire decoder to drop its payload", () => {
    expect(
      composerContextSendBlockReason({
        version: 1,
        records: [{ ...terminal, label: "x".repeat(201) }],
      }),
    ).not.toBeNull();
  });
  it("does not evict live recovery payloads from the editor's bounded undo history", () => {
    const records = Array.from({ length: 400 }, (_, index) => ({
      ...terminal,
      contextId: ComposerContextId.make(`terminal-${index}`),
    }));
    const text = records.map(formatComposerContextReference).join(" ");
    const restore = createComposerContextHistory();
    expect(restore(text, { version: 1, records })?.records).toEqual(records);
    expect(
      restore(records.slice(1).map(formatComposerContextReference).join(" "), {
        version: 1,
        records,
      })?.records,
    ).toEqual(records.slice(1));
  });

  it("blocks a context payload that exceeds the aggregate wire budget", () => {
    const record = {
      ...annotation,
      styleChangeDetails: Array.from({ length: 200 }, () => ({
        targetId: "element",
        selector: null,
        property: "content",
        previousValue: "x".repeat(8_000),
        value: "y".repeat(8_000),
      })),
    };
    expect(composerContextSendBlockReason({ version: 1, records: [record] })).toBeNull();
    expect(
      composerContextSendBlockReason({
        version: 1,
        records: Array.from({ length: 6 }, (_, index) => ({
          ...record,
          contextId: ComposerContextId.make(`preview-${index}`),
        })),
      }),
    ).toContain("too much context");
  });

  it("blocks over-limit recovery drafts until enough context has been removed", () => {
    const records = Array.from({ length: 201 }, (_, index) => ({
      ...terminal,
      contextId: ComposerContextId.make(`terminal-${index}`),
    }));
    expect(composerContextSendBlockReason({ version: 1, records })).toContain("at most 200");
    expect(
      composerContextSendBlockReason({ version: 1, records: records.slice(0, 200) }),
    ).toBeNull();
    expect(composerContextSendBlockReason()).toBeNull();
  });

  it("opens the full file path from bare, quoted, and canonical mentions", () => {
    expect(composerMentionPath("@src/Checkout.tsx")).toBe("src/Checkout.tsx");
    expect(composerMentionPath('@"src/My Checkout.tsx"')).toBe("src/My Checkout.tsx");
    expect(composerMentionPath("[Checkout.tsx](src/Checkout.tsx)")).toBe("src/Checkout.tsx");
    const mention = {
      version: 1 as const,
      kind: "mention" as const,
      contextId: ComposerContextId.make("mention-1"),
      label: "Checkout.tsx",
      path: "src/Checkout.tsx",
    };
    expect(
      composerMentionPath(formatComposerContextReference(mention), {
        version: 1,
        records: [mention],
      }),
    ).toBe("src/Checkout.tsx");
    expect(composerMentionPath(formatComposerContextReference(mention))).toBeNull();
    expect(composerMentionPath("$playwright")).toBeNull();
    expect(
      composerMentionPath(formatComposerContextReference(terminal), {
        version: 1,
        records: [terminal],
      }),
    ).toBeNull();
  });

  it("restores deleted payloads on undo without adding removed context to the current draft", () => {
    const restore = createComposerContextHistory();
    const source = formatComposerContextReference(annotation);
    const initial = { version: 1 as const, records: [annotation, image] };
    expect(restore("deleted", initial)).toBeUndefined();
    expect(restore(source)?.records).toEqual(initial.records);
    expect(restore("deleted")?.records ?? []).toEqual([]);
    expect(createComposerContextHistory()(source)?.records).toEqual([]);
  });
  it("keeps exact source positions and repeated references alongside existing native tokens", () => {
    const reference = formatComposerContextReference(terminal);
    const text = `Use $playwright and [app.ts](src/app.ts) with ${reference} then ${reference}`;
    const tokens = composerContextEditorTokens(text, collectComposerInlineTokens(text));
    expect(tokens.map((token) => token.type)).toEqual(["skill", "mention", "context", "context"]);
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.source);
  });

  it("removes deleted payloads but keeps the screenshot linked to a remaining annotation", () => {
    const context: OrchestrationMessageContext = {
      version: 1,
      records: [terminal, annotation, image],
    };
    expect(
      referencedComposerContext(formatComposerContextReference(annotation), context)?.records,
    ).toEqual([annotation, image]);
    expect(referencedComposerContext("plain text", context)).toBeUndefined();
  });

  it("reidentifies pasted records and their screenshot binding without changing repeated-reference identity", () => {
    let next = 0;
    const text = `${formatComposerContextReference(annotation)} ${formatComposerContextReference(annotation)}`;
    const imported = reidentifyComposerContext(text, [annotation, image], () => `copy-${++next}`);
    expect(collectComposerContextReferences(imported.text).map((ref) => ref.contextId)).toEqual([
      "copy-1",
      "copy-1",
    ]);
    expect(imported.context.records[0]).toMatchObject({
      contextId: "copy-1",
      screenshotContextId: "copy-2",
    });
    expect(annotation.contextId).toBe("preview-1");
  });

  it("binds uploaded files to their wire ids and preserves terminal payloads for every provider", () => {
    const context = uploadedComposerContext(
      { version: 1, records: [terminal, image] },
      [{ id: "local-image" }],
      [{ id: "uploaded-image" }],
    );
    expect(context?.records).toEqual([terminal, { ...image, attachmentId: "uploaded-image" }]);
    const prompt = projectComposerContextForProvider({
      text: formatComposerContextReference(terminal),
      records: context!.records,
    });
    expect(prompt).toContain("4 | build failed\n5 | retry");
    expect(prompt).not.toContain('unavailable="true"');
  });
});

describe("host context compatibility", () => {
  it.each(["existing-thread", "new-task"])("serializes %s sends for an older host", (path) => {
    const pr = pullRequestComposerContext(
      {
        number: 42,
        title: "Fix checkout",
        url: "https://github.com/example/repo/pull/42",
        headBranch: "fix-checkout",
        baseBranch: "main",
        state: "open",
        isDraft: false,
      },
      "pr-42",
    );
    const review = {
      ...pr,
      contextId: ComposerContextId.make("review-1"),
      sectionId: "review",
      filePath: "checkout.ts",
      text: "Handle the empty cart",
      diff: "- old\n+ new",
    };
    const context: OrchestrationMessageContext = { version: 1, records: [terminal, review, pr] };
    const text = context.records.map(formatComposerContextReference).join(" ");
    // Missing capability on an old host is treated like false by both dispatch paths.
    const wire = serializeComposerMessageForServer(text, context, false);
    const message =
      path === "existing-thread"
        ? wire
        : buildProjectThreadStartTurnInput({
            ...wire,
            projectId: ProjectId.make("project"),
            projectCwd: "/workspace",
            threadId: "thread",
            commandId: "command",
            messageId: "message",
            createdAt: "2026-01-01T00:00:00Z",
            uploadedAttachments: [],
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceMode: "local",
            branch: null,
            worktreePath: null,
            startFromOrigin: false,
            worktreeBranchName: "unused",
          }).message;
    expect(message).not.toHaveProperty("context");
    expect(message.text).not.toContain("t3-context://");
    expect(
      upgradeLegacyContextMessage(message.text).records.find(
        (record) => record.kind === "terminal",
      ),
    ).toMatchObject({
      text: terminal.text,
      lineStart: terminal.lineStart,
      lineEnd: terminal.lineEnd,
    });
    expect(message.text).toContain(review.text);
    expect(message.text).toContain(review.diff);
    expect(message.text).toContain(pr.pullRequest!.url);
    expect(serializeComposerMessageForServer(text, context, true)).toEqual({ text, context });
    expect(context.records).toEqual([terminal, review, pr]);
  });
});
