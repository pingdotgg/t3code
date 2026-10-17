import { describe, expect, it } from "vite-plus/test";

import { validateCivilizationSettingsSearch } from "./settings.civilization";

describe("Civilization Settings deep-link search", () => {
  it("keeps only valid exact historical turn identifiers", () => {
    expect(
      validateCivilizationSettingsSearch({
        contextThread: " thread-a ",
        contextRun: " run-a ",
        contextAttempt: " attempt-a ",
        contextTurn: "3",
        packetText: "must-not-pass",
      }),
    ).toEqual({
      contextThread: "thread-a",
      contextRun: "run-a",
      contextAttempt: "attempt-a",
      contextTurn: 3,
    });
  });

  it("drops invalid or incomplete values rather than broadening them", () => {
    expect(
      validateCivilizationSettingsSearch({
        contextThread: "",
        contextRun: 42,
        contextAttempt: null,
        contextTurn: 0,
      }),
    ).toEqual({});
  });
});
