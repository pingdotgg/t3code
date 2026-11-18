import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { parseWhiteboardPanel, whiteboardPanelCapabilities } from "./whiteboardPanel.ts";

it.each([
  { raw: "not json", expected: undefined },
  { raw: "[]", expected: undefined },
  { raw: "null", expected: undefined },
  { raw: '"app"', expected: undefined },
  { raw: "{}", expected: { menu: {} } },
  { raw: '{"menu":"browser"}', expected: { menu: {} } },
  {
    raw: JSON.stringify({
      menu: {
        browser: { hidden: true, key: "x" },
        files: { hidden: "yes", key: "" },
        diff: { key: "DD" },
        device: { key: "é" },
        terminal: "hidden",
        whiteboard: [],
        "future-item": { key: "7", extra: 1 },
      },
    }),
    expected: {
      menu: {
        browser: { hidden: true, key: "X" },
        files: { key: "" },
        diff: {},
        device: {},
        "future-item": { key: "7" },
      },
    },
  },
])("parses $raw leniently", ({ raw, expected }) => {
  expect(parseWhiteboardPanel(raw)).toEqual(expected);
});

it.effect("advertises the board host only while the variable holds an object", () =>
  Effect.gen(function* () {
    const capabilities = (environment: NodeJS.ProcessEnv) =>
      whiteboardPanelCapabilities().pipe(
        Effect.provideService(HostProcess.Environment, environment),
      );

    expect(yield* capabilities({})).toEqual({});
    expect(yield* capabilities({ T3CODE_WHITEBOARD_PANEL: "{oops" })).toEqual({});
    expect(
      yield* capabilities({ T3CODE_WHITEBOARD_PANEL: '{"menu":{"files":{"hidden":true}}}' }),
    ).toEqual({ whiteboardPanel: { menu: { files: { hidden: true } } } });
  }),
);
