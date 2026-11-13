import { describe, expect, it } from "vite-plus/test";

import {
  continueComposerPathTrigger,
  detectComposerTrigger,
  parseSideChatCommand,
  serializeComposerFileLink,
} from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it.each([
    ["Run /tmp/build.sh", "Run /tmp/build.sh".length],
    ["/etc/hosts", "/etc/hosts".length],
    ["Use /etc/hosts now", "Use /et".length],
    ["cmd /foo\\bar", "cmd /foo\\bar".length],
    ["/Windows\\System32", "/Windows\\System32".length],
  ])("keeps the path in %j out of the slash menu", (text, cursor) => {
    expect(detectComposerTrigger(text, cursor)).toBeNull();
  });

  it("keeps a slash in the line-leading model picker query", () => {
    expect(detectComposerTrigger("/model openai/gpt", 17)).toMatchObject({
      kind: "slash-model",
      query: "openai/gpt",
    });
  });

  it.each(["/Model opus", "/MODEL opus"])(
    "opens the model picker for capitalized %j the same as /model",
    (text) => {
      expect(detectComposerTrigger(text, text.length)).toMatchObject({
        kind: "slash-model",
        query: "opus",
      });
    },
  );

  it.each(["Use /", "Use /review"])("detects the inline slash token in %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: text.slice(5),
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each(["Use/review", "https://example.com/review", "Use /review "])(
    "does not trigger for %j",
    (text) => expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it.each(["$", "€", "𑿝"])("detects %s skill prefixes and their source range", (prefix) => {
    const text = `Use ${prefix}review`;
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "skill",
      query: "review",
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each([
    "budget $9.99",
    "only $.99",
    "about €20",
    "raise $10k",
    "$1,000",
    "£2e6",
    "raise $10k.",
  ])("does not open the skill menu for the amount in %j", (text) =>
    expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it.each(["$", "$1password", "$2fa"])("still detects the skill prefix %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toMatchObject({
      kind: "skill",
      query: text.slice(1),
    });
  });
});

describe("serializeComposerFileLink", () => {
  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

describe("parseSideChatCommand", () => {
  it("reads an optional prompt after /side or /btw", () => {
    expect(parseSideChatCommand("/side")).toEqual({ prompt: "" });
    expect(parseSideChatCommand("  /SIDE  why does this fail?\nline two ")).toEqual({
      prompt: "why does this fail?\nline two",
    });
    expect(parseSideChatCommand("/btw check @src/a.ts")).toEqual({ prompt: "check @src/a.ts" });
  });

  it("ignores other commands and inline mentions", () => {
    expect(parseSideChatCommand("/sidebar")).toBeNull();
    expect(parseSideChatCommand("/btwx")).toBeNull();
    expect(parseSideChatCommand("ask /side later")).toBeNull();
  });
});

describe("active path query continuation", () => {
  it("keeps spaces and the far query boundary while moving the caret", () => {
    const before = "Inspect @Foreign then summarize";
    const cursor = "Inspect @Foreign".length;
    const text = "Inspect @Foreign Subsidiaries then summarize";
    const end = "Inspect @Foreign Subsidiaries".length;
    const paths = ["docs/Foreign Subsidiaries/Script Notes.md"];
    const result = continueComposerPathTrigger(
      text,
      end,
      detectComposerTrigger(before, cursor),
      before,
      cursor,
      paths,
    );
    expect(result).toEqual({
      trigger: { kind: "path", query: "Foreign Subsidiaries", rangeStart: 8, rangeEnd: end },
      queryEnd: end,
    });
    const back = continueComposerPathTrigger(
      text,
      cursor,
      result!.trigger,
      text,
      result!.queryEnd,
      paths,
    );
    expect(back?.trigger.query).toBe("Foreign");
    expect(
      continueComposerPathTrigger(text, end, back!.trigger, text, back!.queryEnd, paths)?.trigger
        .query,
    ).toBe("Foreign Subsidiaries");
    expect(
      continueComposerPathTrigger(text, text.length, result!.trigger, text, end, paths),
    ).toBeNull();
    expect(continueComposerPathTrigger(text, end, null, before, cursor, paths)).toBeNull();
  });

  it.each(["\n", "\r", "\t", "\uFFFC"])("ends at the %j boundary", (boundary) => {
    const before = "@Foreign";
    const text = before + boundary;
    expect(
      continueComposerPathTrigger(
        text,
        text.length,
        detectComposerTrigger(before, before.length),
        before,
        before.length,
        null,
      ),
    ).toBeNull();
  });

  it("closes a spaced query that no settled result contains, as prose", () => {
    const before = "Fix @ChatComposer";
    const text = "Fix @ChatComposer so";
    const continueWith = (paths: readonly string[] | null) =>
      continueComposerPathTrigger(
        text,
        text.length,
        detectComposerTrigger(before, before.length),
        before,
        before.length,
        paths,
      )?.trigger.query;
    expect(continueWith(["apps/web/src/components/chat/ChatComposer.tsx"])).toBeUndefined();
    expect(continueWith(["docs/ChatComposer so far.md"])).toBe("ChatComposer so");
    expect(continueWith(null)).toBe("ChatComposer so");
  });
});
