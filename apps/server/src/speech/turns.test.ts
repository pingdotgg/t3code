import { expect, it } from "vite-plus/test";
import { DEFAULT_TURN_SETTINGS, makeTurnDetector, requiredSilenceMs } from "./turns.ts";

const ms = (value: number) => value * 16;

it.each([
  ["Run the tests.", 800],
  ["Is it green?", 800],
  ['He said "done."', 800],
  ["Run the tests,", 3000],
  ["Open the file and", 3000],
  ["check the", 3000],
  ["Run the tests", 1500],
  ["Sandy", 1500],
])("waits for the pause that %j calls for", (text, wait) => {
  expect(requiredSilenceMs(text, DEFAULT_TURN_SETTINGS)).toBe(wait);
});

it("ends an utterance once the silence after speech reaches the required pause", () => {
  const turns = makeTurnDetector();
  expect(turns.observe({ samples: ms(500), voicedUntil: ms(450), text: "Run the tests" })).toEqual({
    heard: true,
    speechStarted: true,
    ended: false,
  });
  expect(turns.observe({ samples: ms(1900), voicedUntil: ms(450), text: "Run the tests" })).toEqual(
    { heard: false, speechStarted: false, ended: false },
  );
  expect(turns.observe({ samples: ms(1950), voicedUntil: ms(450), text: "Run the tests" })).toEqual(
    { heard: false, speechStarted: false, ended: true },
  );
});

it("ends a finished sentence sooner and holds an unfinished one longer", () => {
  const finished = makeTurnDetector();
  finished.observe({ samples: ms(500), voicedUntil: ms(500), text: "Run the tests." });
  expect(
    finished.observe({ samples: ms(1500), voicedUntil: ms(500), text: "Run the tests." }).ended,
  ).toBe(true);
  const unfinished = makeTurnDetector();
  unfinished.observe({ samples: ms(500), voicedUntil: ms(500), text: "Run the tests and" });
  expect(
    unfinished.observe({ samples: ms(3400), voicedUntil: ms(500), text: "Run the tests and" })
      .ended,
  ).toBe(false);
  expect(
    unfinished.observe({ samples: ms(3500), voicedUntil: ms(500), text: "Run the tests and" })
      .ended,
  ).toBe(true);
});

it("reports speech starting again only after a real gap, and never ends without words", () => {
  const turns = makeTurnDetector();
  expect(turns.observe({ samples: ms(5000), voicedUntil: ms(400), text: "" })).toEqual({
    heard: true,
    speechStarted: true,
    ended: false,
  });
  expect(
    turns.observe({ samples: ms(5500), voicedUntil: ms(5500), text: "hi" }).speechStarted,
  ).toBe(true);
  expect(turns.observe({ samples: ms(5600), voicedUntil: ms(5600), text: "hi there" })).toEqual({
    heard: true,
    speechStarted: false,
    ended: false,
  });
  turns.reset();
  expect(
    turns.observe({ samples: ms(500), voicedUntil: ms(200), text: "next" }).speechStarted,
  ).toBe(true);
});

it("ends at the maximum length even while speech continues", () => {
  const turns = makeTurnDetector({ ...DEFAULT_TURN_SETTINGS, maxUtteranceMs: 2000 });
  expect(
    turns.observe({ samples: ms(2000), voicedUntil: ms(2000), text: "keep talking" }).ended,
  ).toBe(true);
});

it("falls back to transcript changes when no silence detector reports speech", () => {
  const turns = makeTurnDetector();
  expect(
    turns.observe({ samples: ms(500), voicedUntil: undefined, text: "Run the tests." }),
  ).toEqual({
    heard: true,
    speechStarted: true,
    ended: false,
  });
  expect(
    turns.observe({ samples: ms(1000), voicedUntil: undefined, text: "Run the tests." }).ended,
  ).toBe(false);
  expect(
    turns.observe({ samples: ms(1500), voicedUntil: undefined, text: "Run the tests." }).ended,
  ).toBe(true);
});
