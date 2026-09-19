import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { DictationSettings, VoicePolishRequest } from "./voice.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";
const decodeSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeDictationSettings = Schema.decodeUnknownSync(DictationSettings);

describe("dictation preferences and optional edits", () => {
  it.each([
    {},
    { autoPolish: false },
    { spokenCommands: false },
    { removeFillers: false },
    { replacements: [] },
    { replacements: [{ kind: "word", phrase: "tea three", replacement: "T3" }] },
  ])("preserves omitted fields in the dictation patch %j", (dictation) => {
    expect(decodeSettingsPatch({ dictation })).toEqual({ dictation });
  });

  it.each([
    { replacements: [{ kind: "word", phrase: " ", replacement: "name" }] },
    {
      replacements: Array.from({ length: 201 }, () => ({
        kind: "word",
        phrase: "a",
        replacement: "b",
      })),
    },
  ])("validates replacement libraries in partial patches", ({ replacements }) => {
    expect(() => decodeSettingsPatch({ dictation: { replacements } })).toThrow();
  });

  it("defaults older settings and round-trips personal words and snippets", () => {
    const decode = Schema.decodeUnknownSync(ServerSettings);
    expect(decode({}).dictation).toEqual({
      autoPolish: false,
      spokenCommands: true,
      removeFillers: true,
      replacements: [],
    });
    const dictation = {
      autoPolish: true,
      spokenCommands: false,
      removeFillers: false,
      replacements: [
        { kind: "snippet", phrase: "my checklist", replacement: "1. Test\n2. Review" },
      ],
    };
    expect(decode({ dictation: { spokenCommands: false } }).dictation.autoPolish).toBe(false);
    expect(decode({ dictation }).dictation).toEqual(dictation);
    expect(decodeSettingsPatch({ dictation })).toEqual({ dictation });
  });
  it("bounds phrase libraries and rejects empty phrases", () => {
    const decode = Schema.decodeUnknownSync(DictationSettings);
    expect(() =>
      decode({ replacements: [{ kind: "word", phrase: " ", replacement: "name" }] }),
    ).toThrow();
    expect(() =>
      decode({
        replacements: Array.from({ length: 201 }, () => ({
          kind: "word",
          phrase: "a",
          replacement: "b",
        })),
      }),
    ).toThrow();
  });
  it.each(["", "   ", "\n\t", "a".repeat(4001)])(
    "rejects blank or oversized replacements",
    (replacement) => {
      const replacements = [{ kind: "snippet", phrase: "my snippet", replacement }];
      expect(() => decodeDictationSettings({ replacements })).toThrow();
      expect(() => decodeSettingsPatch({ dictation: { replacements } })).toThrow();
    },
  );
  it("preserves intentional whitespace in nonempty snippets", () => {
    const replacements = [{ kind: "snippet", phrase: "my snippet", replacement: "\n  code\n" }];
    expect(decodeSettingsPatch({ dictation: { replacements } })).toEqual({
      dictation: { replacements },
    });
  });
  it("requires a bounded text and a supported editing style", () => {
    const decode = Schema.decodeUnknownSync(VoicePolishRequest);
    expect(() => decode({ instanceId: "codex", text: "", style: "cleanup" })).toThrow();
    expect(() => decode({ instanceId: "codex", text: "hello", style: "execute" })).toThrow();
    expect(() =>
      decode({ instanceId: "codex", text: "a".repeat(30_001), style: "cleanup" }),
    ).toThrow();
  });
});
