import { EnvironmentId, type ExplicitFileMention } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { serializeComposerFileLink } from "./composerTrigger.ts";
import {
  reconcileFileMentionsAfterEdit,
  trimTextWithFileMentions,
  validateExplicitFileMentions,
} from "./fileMentions.ts";

const environmentId = EnvironmentId.make("environment-1");

function mention(path: string, start = 0): ExplicitFileMention {
  return {
    version: 1,
    environmentId,
    path,
    kind: "file",
    start,
    end: start + serializeComposerFileLink(path).length,
  };
}

describe("explicit file mentions", () => {
  it("validates UTF-16 ranges, source text, ordering, and environment", () => {
    const source = serializeComposerFileLink("/tmp/💾.txt");
    const valid = mention("/tmp/💾.txt", 2);
    const text = `😀${source}`;

    expect(validateExplicitFileMentions(text, [valid], environmentId)).toBeNull();
    expect(validateExplicitFileMentions(text, [{ ...valid, start: 1 }], environmentId)).toBe(
      "source",
    );
    expect(
      validateExplicitFileMentions(
        text,
        [valid, { ...valid, start: valid.end - 1 }],
        environmentId,
      ),
    ).toBe("overlap");
    expect(validateExplicitFileMentions(text, [valid], EnvironmentId.make("environment-2"))).toBe(
      "environment",
    );
  });

  it("shifts intact mentions and drops mentions touched by an edit", () => {
    const source = serializeComposerFileLink("/tmp/a.txt");
    const original = `one ${source} two`;
    const originalMention = mention("/tmp/a.txt", 4);

    expect(reconcileFileMentionsAfterEdit(original, `😀 ${original}`, [originalMention])).toEqual([
      { ...originalMention, start: 7, end: originalMention.end + 3 },
    ]);
    expect(
      reconcileFileMentionsAfterEdit(original, original.replace("a.txt", "b.txt"), [
        originalMention,
      ]),
    ).toEqual([]);
  });

  it("drops provenance when repeated text makes the retained occurrence ambiguous", () => {
    const source = serializeComposerFileLink("/tmp/a.txt");
    const original = `${source} ${source}`;

    expect(reconcileFileMentionsAfterEdit(original, source, [mention("/tmp/a.txt", 0)])).toEqual(
      [],
    );
  });

  it("maps mentions through trimming without losing interior ranges", () => {
    const source = serializeComposerFileLink("/tmp/a.txt");
    const originalMention = mention("/tmp/a.txt", 2);
    expect(trimTextWithFileMentions(`  ${source}  `, [originalMention])).toEqual({
      text: source,
      fileMentions: [{ ...originalMention, start: 0, end: source.length }],
    });
  });
});
