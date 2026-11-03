import { threadDeepLink } from "@t3tools/shared/threadDeepLinks";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { type ComposerContextClipboardFragment, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import {
  importPastedComposerText,
  readPastedComposerContext,
  isComposerContextPaste,
} from "./composerInlineTokenPaste";

const thread = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const clipboard = (data: Record<string, string>) => ({
  getData: (type: string) => data[type] ?? "",
});
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

const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const record = threadContextRecord(ref, "Fix login");
function legacyClipboard(text: string, rich = false) {
  return {
    getData: (type: string) =>
      type === "text/plain"
        ? text
        : rich && type === COMPOSER_CONTEXT_CLIPBOARD_MIME
          ? encodeComposerContextFragment({
              version: 1,
              source: { environmentId: ref.environmentId },
              records: [record],
            })!
          : "",
  };
}
describe("pasted thread deep links", () => {
  it("imports a copied thread card while the plain clipboard stays a public URL", () => {
    const data = legacyClipboard(threadDeepLink(ref), true);
    const fragment = readPastedComposerContext(data)!;
    expect(fragment.records).toEqual([record]);
    const result = importPastedComposerText(
      data,
      (f) => new Map(f.records.map((r) => [r.contextId, r.contextId])),
    );
    expect(result).toBe(formatComposerContextReference(record));
    expect(data.getData("text/plain")).toBe("https://app.t3.codes/env/thread");
  });
  it("imports public URLs after clipboard metadata has been stripped", () => {
    const data = legacyClipboard(threadDeepLink(ref));
    const result = importPastedComposerText(
      data,
      (f) => new Map(f.records.map((r) => [r.contextId, "imported-thread"])),
    );
    expect(collectComposerContextReferences(result)).toMatchObject([
      { contextId: "imported-thread", kind: "thread" },
    ]);
  });
  it("keeps raw URLs when there is no importer or the machine cannot read the thread", () => {
    const data = legacyClipboard(threadDeepLink(ref));
    expect(importPastedComposerText(data)).toBe(threadDeepLink(ref));
    expect(importPastedComposerText(data, () => new Map())).toBe(threadDeepLink(ref));
  });
  it("preserves legacy context reference paste", () => {
    const data = legacyClipboard(formatComposerContextReference(record), true);
    expect(readPastedComposerContext(data)?.records).toEqual([record]);
    expect(
      importPastedComposerText(
        data,
        (f) => new Map(f.records.map((r) => [r.contextId, r.contextId])),
      ),
    ).toBe(formatComposerContextReference(record));
  });
});

it("allows large logs with an incidental thread URL to fold", () => {
  expect(
    isComposerContextPaste(legacyClipboard("log line\n".repeat(10000) + threadDeepLink(ref))),
  ).toBe(false);
  expect(isComposerContextPaste(legacyClipboard(threadDeepLink(ref)))).toBe(true);
});
