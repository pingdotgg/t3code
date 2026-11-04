import { describe, expect, it } from "vite-plus/test";
import { compactSessionModel, sessionMachineLabel } from "./sessionLabels";

describe("session labels", () => {
  it.each([
    ["6.1 Sol", "S6.1"],
    ["GPT-6 Astra", "A6"],
    ["Claude Opus 4.6", "O4.6"],
    ["claude-opus-4-6", "O4.6"],
    ["Fable 5.5", "F5.5"],
    ["Opus", "O"],
    ["Gemini 3 Pro", "Gemini 3 Pro"],
  ])("formats %s as %s", (label, expected) => {
    expect(compactSessionModel(label)).toBe(expected);
  });

  it.each([
    ["m3", "M3"],
    ["m5", "M5"],
    ["j", "J"],
    ["Other host", "Other host"],
  ])("formats host %s as %s", (label, expected) =>
    expect(sessionMachineLabel(label)).toBe(expected),
  );
});
