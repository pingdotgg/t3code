import { describe, expect, it } from "vite-plus/test";
import {
  captureVoicePolish,
  captureVoicePolishUndo,
  resolveVoicePolishCommit,
} from "./voicePolish";

const draft = {
  ownerKey: "env:thread:answer",
  text: "hello world",
  selectionStart: 6,
  selectionEnd: 11,
};
describe("optional AI editing", () => {
  it("edits a selection or the entire draft when the caret is collapsed", () => {
    expect(captureVoicePolish(draft)).toEqual(draft);
    expect(captureVoicePolish({ ...draft, selectionEnd: 6 })).toMatchObject({
      selectionStart: 0,
      selectionEnd: 11,
    });
    expect(resolveVoicePolishCommit(draft, draft, "everyone")).toEqual({
      rangeStart: 6,
      rangeEnd: 11,
      expectedText: "world",
      insertion: "everyone",
    });
  });
  it("rejects results after typing, sending, or changing the target", () => {
    for (const current of [
      null,
      { ...draft, text: "new text" },
      { ...draft, text: "" },
      { ...draft, ownerKey: "other" },
    ])
      expect(resolveVoicePolishCommit(draft, current, "suggestion")).toBeNull();
    expect(resolveVoicePolishCommit(draft, draft, "")).toBeNull();
  });
  it("allows moving the caret while a suggestion is generated", () => {
    expect(
      resolveVoicePolishCommit(draft, { ...draft, selectionStart: 0, selectionEnd: 0 }, "everyone"),
    ).not.toBeNull();
  });
});

it("undo restores the selected original only if the polished draft is unchanged", () => {
  const undo = captureVoicePolishUndo(draft, "everyone!");
  expect(undo.captured.text).toBe("hello everyone!");
  expect(resolveVoicePolishCommit(undo.captured, undo.captured, undo.text)).toEqual({
    rangeStart: 6,
    rangeEnd: 15,
    expectedText: "everyone!",
    insertion: "world",
  });
  expect(
    resolveVoicePolishCommit(
      undo.captured,
      { ...undo.captured, text: "hello everyone! typed" },
      undo.text,
    ),
  ).toBeNull();
});
