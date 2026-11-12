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
  it("turns a context reference without a fragment into its plain label", () => {
    expect(importPastedComposerText(clipboard({ "text/plain": pastedText }), importNothing)).toBe(
      "Read this: Source Thread Ready and continue.",
    );
  });

  it("turns a context reference whose record the import dropped into its plain label", () => {
    const fragment = encodeComposerContextFragment({
      version: 1,
      source: { environmentId: sourceThread.environmentId },
      records: [sourceThread],
    });
    expect(
      importPastedComposerText(
        clipboard({ "text/plain": pastedText, [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment ?? "" }),
        importNothing,
      ),
    ).toBe("Read this: Source Thread Ready and continue.");
  });

  it("keeps context references inside pasted code as written", () => {
    const reference = formatComposerContextReference(sourceThread);
    const code = `\`\`\`md\n${reference}\n\`\`\`\nInline \`${reference}\` and ${reference}`;
    expect(importPastedComposerText(clipboard({ "text/plain": code }), importNothing)).toBe(
      `\`\`\`md\n${reference}\n\`\`\`\nInline \`${reference}\` and Source Thread Ready`,
    );
  });

  it("keeps a reference in a fence whose body holds a fence marker mid-line", () => {
    const reference = formatComposerContextReference(sourceThread);
    const code = `\`\`\`js\nconsole.log("\`\`\`");\n${reference}\n\`\`\``;
    expect(importPastedComposerText(clipboard({ "text/plain": code }), importNothing)).toBe(code);
  });

  it("imports a reference between escaped backticks", () => {
    const fragment = encodeComposerContextFragment({
      version: 1,
      source: { environmentId: sourceThread.environmentId },
      records: [sourceThread],
    });
    const localId = ComposerContextId.make("thread-local");
    const text = `\\\`${formatComposerContextReference(sourceThread)}\\\``;
    expect(
      importPastedComposerText(
        clipboard({ "text/plain": text, [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment ?? "" }),
        () => new Map([[sourceThread.contextId, localId]]),
      ),
    ).toBe(`\\\`${formatComposerContextReference({ ...sourceThread, contextId: localId })}\\\``);
  });

  it("imports a reference whose label holds backticks", () => {
    const thread = threadContextRecord(
      { environmentId: sourceThread.environmentId, threadId: ThreadId.make("thread-code") },
      "Fix `foo` bug",
    );
    const fragment = encodeComposerContextFragment({
      version: 1,
      source: { environmentId: thread.environmentId },
      records: [thread],
    });
    const localId = ComposerContextId.make("thread-local");
    expect(
      importPastedComposerText(
        clipboard({
          "text/plain": `Quote with \`, see ${formatComposerContextReference(thread)}`,
          [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment ?? "",
        }),
        (pasted) => new Map(pasted.records.map((record) => [record.contextId, localId])),
      ),
    ).toBe(
      `Quote with \`, see ${formatComposerContextReference({ ...thread, contextId: localId })}`,
    );
  });

  it("keeps a context reference whose record the draft already holds", () => {
    expect(
      importPastedComposerText(
        clipboard({ "text/plain": pastedText }),
        importNothing,
        new Set([sourceThread.contextId]),
      ),
    ).toBe(pastedText);
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
});
