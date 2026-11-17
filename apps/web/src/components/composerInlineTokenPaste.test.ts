import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import {
  type ComposerContextClipboardFragment,
  ComposerContextId,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import {
  formatComposerContextReference,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { importPastedComposerText } from "./composerInlineTokenPaste";

const sourceThread = threadContextRecord(
  {
    environmentId: EnvironmentId.make("environment-elsewhere"),
    threadId: ThreadId.make("thread-source"),
  },
  "Source Thread Ready",
);
const pastedText = `Read this: ${formatComposerContextReference(sourceThread)} and continue.`;

function clipboard(data: Record<string, string>) {
  return { getData: (format: string) => data[format] ?? "" };
}

const importNothing = () => new Map<string, string>();

const thread = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const chip = (title: string) =>
  `[${title}](t3-context://v1/thread/${threadContextRecord(thread, title).contextId})`;

/** Imports every record it is offered, as the composer does for a thread its agent can read. */
const importAll =
  (imported: Array<ComposerContextClipboardFragment>) =>
  (fragment: ComposerContextClipboardFragment) => {
    imported.push(fragment);
    return new Map(fragment.records.map((record) => [record.contextId, record.contextId]));
  };

describe("importPastedComposerText", () => {
  const reference = formatComposerContextReference(sourceThread);
  const codeThread = threadContextRecord(
    { environmentId: sourceThread.environmentId, threadId: ThreadId.make("thread-code") },
    "Fix `foo` bug",
  );
  const localId = ComposerContextId.make("thread-local");
  const importAsLocal = (pasted: ComposerContextClipboardFragment) =>
    new Map(pasted.records.map((record) => [record.contextId, localId]));
  it.each([
    {
      name: "a reference without a fragment becomes its label",
      text: pastedText,
      expected: "Read this: Source Thread Ready and continue.",
    },
    {
      name: "a reference whose record the import dropped becomes its label",
      text: pastedText,
      records: [sourceThread],
      expected: "Read this: Source Thread Ready and continue.",
    },
    {
      name: "a reference the draft already holds stays",
      text: pastedText,
      held: [sourceThread.contextId],
      expected: pastedText,
    },
    {
      name: "references inside fenced and inline code stay as written",
      text: `\`\`\`md\n${reference}\n\`\`\`\nInline \`${reference}\` and ${reference}`,
      expected: `\`\`\`md\n${reference}\n\`\`\`\nInline \`${reference}\` and Source Thread Ready`,
    },
    {
      name: "a fence holding a fence marker mid-line stays open",
      text: `\`\`\`js\nconsole.log("\`\`\`");\n${reference}\n\`\`\``,
      expected: `\`\`\`js\nconsole.log("\`\`\`");\n${reference}\n\`\`\``,
    },
    {
      name: "a reference between escaped backticks is imported",
      text: `\\\`${reference}\\\``,
      records: [sourceThread],
      importContext: importAsLocal,
      expected: `\\\`${formatComposerContextReference({ ...sourceThread, contextId: localId })}\\\``,
    },
    {
      name: "a CR-only fence closes before a reference after it",
      text: `~~~\rcode\r~~~\r${reference}`,
      records: [sourceThread],
      importContext: importAsLocal,
      expected: `~~~\ncode\n~~~\n${formatComposerContextReference({ ...sourceThread, contextId: localId })}`,
    },
    {
      name: "backticks in a reference's label do not open code",
      text: `Quote with \`, see ${formatComposerContextReference(codeThread)}`,
      records: [codeThread],
      importContext: importAsLocal,
      expected: `Quote with \`, see ${formatComposerContextReference({ ...codeThread, contextId: localId })}`,
    },
  ])("$name", ({ text, records, importContext = importNothing, held = [], expected }) => {
    const fragment = records
      ? encodeComposerContextFragment({
          version: 1,
          source: { environmentId: sourceThread.environmentId },
          records,
        })!
      : "";
    expect(
      importPastedComposerText(
        clipboard({ "text/plain": text, [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment }),
        importContext,
        new Set<string>(held),
      ),
    ).toBe(expected);
  });

  it("pastes a copied thread link back as the chip it was copied from", () => {
    const target = threadChipCopyTarget(thread, "Fix the login flow");
    const imported: Array<ComposerContextClipboardFragment> = [];
    const text = importPastedComposerText(
      clipboard({
        "text/plain": `See ${target.value}`,
        [COMPOSER_CONTEXT_CLIPBOARD_MIME]: encodeComposerContextFragment(target.fragment!)!,
      }),
      importAll(imported),
    );
    expect(text).toBe(`See ${chip("Fix the login flow")}`);
    expect(imported.map((fragment) => fragment.records)).toEqual([target.fragment!.records]);
  });

  it("makes a chip of a v2 link pasted without T3's clipboard format", () => {
    const text = importPastedComposerText(
      clipboard({ "text/plain": "[Login](t3-thread://v2/env-1/thread-1)" }),
      importAll([]),
    );
    expect(text).toBe(chip("Login"));
  });

  it("keeps the link when the composer cannot take the thread", () => {
    const pasted = "https://app.t3.codes/threads/env-1/thread-1";
    expect(importPastedComposerText(clipboard({ "text/plain": pasted }), () => new Map())).toBe(
      pasted,
    );
  });

  it("imports CRLF and CR clipboard text with LF line breaks", () => {
    expect(
      importPastedComposerText(clipboard({ "text/plain": "x\r\n\r\ny\rz" }), () => new Map()),
    ).toBe("x\n\ny\nz");
  });
});
