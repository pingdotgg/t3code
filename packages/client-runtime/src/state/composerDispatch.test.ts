import { expect, it } from "vite-plus/test";

import { compactionBlocksSteering, composerRunsDraftLocally } from "./composerDispatch.ts";

it("blocks steering for explicit compaction, and for automatic compaction unless the provider takes steers then", () => {
  const during = (
    text: string | undefined,
    attachments: ReadonlyArray<unknown> = [],
    steersDuringCompaction = true,
  ) =>
    compactionBlocksSteering({
      compactCommandIsActive: false,
      compactionRunning: true,
      steersDuringCompaction,
      run: { userMessageId: "user" },
      messages: [
        ...(text === undefined ? [] : [{ id: "user", text, attachments }]),
        { id: "later", text: "/compact" },
      ],
    });

  for (const text of ["/compact", "  /COMPACT  ", "/compact keep the debugging notes"]) {
    expect(during(text)).toBe(true);
  }
  for (const text of ["Read the code", "/compactify", "please /compact", undefined]) {
    expect(during(text)).toBe(false);
  }
  expect(during("/compact", [{}])).toBe(false);
  expect(during("Read the code", [], false)).toBe(true);

  expect(
    compactionBlocksSteering({
      compactCommandIsActive: true,
      compactionRunning: false,
      steersDuringCompaction: true,
      run: undefined,
      messages: undefined,
    }),
  ).toBe(true);
  expect(
    compactionBlocksSteering({
      compactCommandIsActive: false,
      compactionRunning: false,
      steersDuringCompaction: false,
      run: { userMessageId: "user" },
      messages: [{ id: "user", text: "/compact" }],
    }),
  ).toBe(false);
});

it("treats only the commands the composer runs itself as local", () => {
  const none = {
    holdsOnlyText: true,
    sideChat: false,
    usageLimits: false,
    codexFeedback: false,
    freshSession: false,
  };
  const all = {
    ...none,
    sideChat: true,
    usageLimits: true,
    codexFeedback: true,
    freshSession: true,
  };
  for (const text of ["/btw why?", "/usage-limits", "/feedback slow", "/clear"]) {
    expect(composerRunsDraftLocally({ ...all, text })).toBe(true);
    expect(composerRunsDraftLocally({ ...none, text })).toBe(false);
  }
  expect(composerRunsDraftLocally({ ...all, text: "fix the bug" })).toBe(false);
  expect(composerRunsDraftLocally({ ...all, holdsOnlyText: false, text: "/clear" })).toBe(false);
  expect(composerRunsDraftLocally({ ...all, holdsOnlyText: false, text: "/side why?" })).toBe(true);
  const local = (command: string) =>
    composerRunsDraftLocally({
      ...all,
      text: `[Reply](t3-context://v1/response/gone) ${command}`,
      textWithoutContextReferences: command,
    });
  expect(local("/feedback slow")).toBe(true);
  expect(local("/clear")).toBe(true);
  expect(local("/usage-limits")).toBe(false);
});
