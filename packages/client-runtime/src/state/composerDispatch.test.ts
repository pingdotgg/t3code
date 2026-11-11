import { expect, it } from "vite-plus/test";

import { isExplicitCompactionActive } from "./composerDispatch.ts";

it("blocks steering only for explicit compaction, not automatic compaction", () => {
  const during = (text: string | undefined, attachments: ReadonlyArray<unknown> = []) =>
    isExplicitCompactionActive({
      compactCommandIsActive: false,
      compactionRunning: true,
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

  expect(
    isExplicitCompactionActive({
      compactCommandIsActive: true,
      compactionRunning: false,
      run: undefined,
      messages: undefined,
    }),
  ).toBe(true);
  expect(
    isExplicitCompactionActive({
      compactCommandIsActive: false,
      compactionRunning: false,
      run: { userMessageId: "user" },
      messages: [{ id: "user", text: "/compact" }],
    }),
  ).toBe(false);
});
