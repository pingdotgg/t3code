import { expect, it } from "vite-plus/test";

import { isExplicitCompactionActive, resolveComposerDispatchMode } from "./composerDispatch.ts";

it("uses the run's retained message when its initiating timeline item is paged out", () => {
  expect(
    isExplicitCompactionActive({
      compactCommandIsActive: false,
      compactionRunning: true,
      run: { userMessageId: "command" },
      messages: [
        { id: "command", text: "/compact keep the debugging notes" },
        { id: "steer", text: "A later follow-up" },
      ],
    }),
  ).toBe(true);
});

it("allows steering during automatic compaction and preserves Queue and alternate dispatch", () => {
  const canSteer = !isExplicitCompactionActive({
    compactCommandIsActive: false,
    compactionRunning: true,
    run: { userMessageId: "user" },
    messages: [{ id: "user", text: "Read the code" }],
  });
  expect(resolveComposerDispatchMode({ running: true, alternateModifier: false, canSteer })).toBe(
    "steer",
  );
  expect(resolveComposerDispatchMode({ running: true, alternateModifier: true, canSteer })).toBe(
    "queue",
  );
  expect(
    resolveComposerDispatchMode({
      running: true,
      alternateModifier: false,
      activeTurnDefault: "queue",
      canSteer,
    }),
  ).toBe("queue");
});

it("blocks steering only for a pending compact command or a running explicit compaction", () => {
  expect(
    isExplicitCompactionActive({
      compactCommandIsActive: true,
      compactionRunning: false,
      run: undefined,
      messages: undefined,
    }),
  ).toBe(true);
  for (const text of ["/compact", "  /COMPACT  ", "/compact keep the debugging notes"]) {
    const canSteer = !isExplicitCompactionActive({
      compactCommandIsActive: false,
      compactionRunning: true,
      run: { userMessageId: "user" },
      messages: text === undefined ? [] : [{ id: "user", text }],
    });
    expect(resolveComposerDispatchMode({ running: true, alternateModifier: false, canSteer })).toBe(
      "queue",
    );
    expect(resolveComposerDispatchMode({ running: true, alternateModifier: true, canSteer })).toBe(
      "queue",
    );
    expect(
      isExplicitCompactionActive({
        compactCommandIsActive: false,
        compactionRunning: false,
        run: { userMessageId: "user" },
        messages: text === undefined ? [] : [{ id: "user", text }],
      }),
    ).toBe(false);
  }
  for (const text of ["/compactify", "please /compact", undefined]) {
    expect(
      isExplicitCompactionActive({
        compactCommandIsActive: false,
        compactionRunning: true,
        run: { userMessageId: "user" },
        messages: text === undefined ? [] : [{ id: "user", text }],
      }),
    ).toBe(false);
  }
});

it("allows steering when an attached compact prompt compacts automatically", () => {
  const message = { id: "user", text: "/compact", attachments: [{}] };
  const canSteer = !isExplicitCompactionActive({
    compactCommandIsActive: false,
    compactionRunning: true,
    run: { userMessageId: "user" },
    messages: [message],
  });
  expect(resolveComposerDispatchMode({ running: true, alternateModifier: false, canSteer })).toBe(
    "steer",
  );
});
