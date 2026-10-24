import { describe, expect, it } from "vite-plus/test";
import { ComposerContextId, type OrchestrationMessageContext } from "@t3tools/contracts";
import { composerRecallContext, recallComposerText } from "./composerContextReferences.ts";

describe("composer recall provenance", () => {
  it("distinguishes identical sent text with different origins", () => {
    const sent = "Ultrathink:\nKeep this prefix";
    expect(recallComposerText(sent, composerRecallContext(sent, sent))).toBe(sent);
    expect(recallComposerText(sent, composerRecallContext(sent, "Keep this prefix"))).toBe(
      "Keep this prefix",
    );
  });

  it.each([
    "<review_comment>literal</review_comment>",
    "<terminal_context>\n- Terminal line 1:\n  literal\n</terminal_context>",
    "<element_context>\n- button:\n  literal\n</element_context>",
    "<preview_annotation>\nComment: literal\n</preview_annotation>",
    "PLEASE IMPLEMENT THIS PLAN:\nliteral",
    "  whitespace and 😀\n",
    "[literal](t3-context://v1/terminal/no-record)",
  ])("preserves literal bytes while omitting generated content: %s", (authored) => {
    const sent = `Ultrathink:\n${authored.trim()}\n\n<review_comment>generated</review_comment>`;
    expect(recallComposerText(sent, composerRecallContext(sent, authored))).toBe(authored);
    expect(recallComposerText(sent)).toBe(sent);
  });

  it("excludes only references backed by actual context records", () => {
    const context: OrchestrationMessageContext = {
      version: 1,
      records: [
        {
          version: 1,
          kind: "terminal",
          contextId: ComposerContextId.make("term"),
          label: "Terminal",
          terminalId: "terminal",
          terminalLabel: "Terminal",
          lineStart: 1,
          lineEnd: 1,
          text: "output",
        },
      ],
    };
    const authored =
      "Look at [Terminal](t3-context://v1/terminal/term) please\n[literal](t3-context://v1/terminal/missing)";
    expect(recallComposerText(authored, composerRecallContext(authored, authored, context))).toBe(
      "Look at please\n[literal](t3-context://v1/terminal/missing)",
    );
  });

  it("omits wholly generated prompts, without omitting the same literal user input", () => {
    for (const text of ["PLEASE IMPLEMENT THIS PLAN:\nplan", "Please review the attached image."]) {
      expect(recallComposerText(text, composerRecallContext(text, ""))).toBe("");
      expect(recallComposerText(text, composerRecallContext(text, text))).toBe(text);
    }
  });

  it("does not duplicate large ordinary or prefixed prompts", () => {
    const authored = "x".repeat(100_000);
    expect(composerRecallContext(authored, authored)).toBeUndefined();
    const sent = `Ultrathink:\n${authored}`;
    const context = composerRecallContext(sent, authored);
    expect(JSON.stringify(context).length).toBeLessThan(100);
    expect(recallComposerText(sent, context)).toBe(authored);
  });

  it("fails open to the stored text for stale or invalid ranges", () => {
    expect(recallComposerText("short", { version: 1, records: [], composerRecall: [0, 99] })).toBe(
      "short",
    );
    expect(recallComposerText("short", { version: 1, records: [], composerRecall: [3, 1] })).toBe(
      "short",
    );
  });

  it("replaces stale provenance when editing the queued text", () => {
    const previous = composerRecallContext("Ultrathink:\nold", "old");
    const edited = "Ultrathink:\nnew literal prefix";
    expect(recallComposerText(edited, composerRecallContext(edited, edited, previous))).toBe(
      edited,
    );
  });

  it("retains original whitespace when an unchanged queued draft is saved again", () => {
    const authored = "  original draft\n";
    const queued = authored.trim();
    const context = composerRecallContext(queued, authored);
    expect(recallComposerText(queued, composerRecallContext(queued, queued, context, queued))).toBe(
      authored,
    );
    expect(
      recallComposerText("edited", composerRecallContext("edited", "edited", context, queued)),
    ).toBe("edited");
  });
});
