import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { threadDeepLink } from "@t3tools/shared/threadDeepLinks";
import {
  importPastedComposerText,
  readPastedComposerContext,
  isComposerContextPaste,
} from "./composerInlineTokenPaste";
const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const record = threadContextRecord(ref, "Fix login");
function clipboard(text: string, rich = false) {
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
    const data = clipboard(threadDeepLink(ref), true);
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
    const data = clipboard(threadDeepLink(ref));
    const result = importPastedComposerText(
      data,
      (f) => new Map(f.records.map((r) => [r.contextId, "imported-thread"])),
    );
    expect(collectComposerContextReferences(result)).toMatchObject([
      { contextId: "imported-thread", kind: "thread" },
    ]);
  });
  it("keeps raw URLs when there is no importer or the machine cannot read the thread", () => {
    const data = clipboard(threadDeepLink(ref));
    expect(importPastedComposerText(data)).toBe(threadDeepLink(ref));
    expect(importPastedComposerText(data, () => new Map())).toBe(threadDeepLink(ref));
  });
  it("preserves legacy context reference paste", () => {
    const data = clipboard(formatComposerContextReference(record), true);
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
  expect(isComposerContextPaste(clipboard("log line\n".repeat(10000) + threadDeepLink(ref)))).toBe(
    false,
  );
  expect(isComposerContextPaste(clipboard(threadDeepLink(ref)))).toBe(true);
});
