import { decideDaybreakModelChange } from "@t3tools/client-runtime/model-traits";
import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  blocksBulkDaybreakChange,
  intersectDaybreakDescriptors,
} from "./ProjectDefaultsSettings.logic";

const instanceId = ProviderInstanceId.make("codex");
const selection = (program: string, effort = "high"): ModelSelection => ({
  instanceId,
  model: "gpt-5.4",
  options: [
    { id: "cyberAccessProgram", value: program },
    { id: "reasoning", value: effort },
  ],
});
const descriptor = (...programs: string[]): ProviderOptionDescriptor => ({
  id: "cyberAccessProgram",
  type: "select",
  label: "Daybreak",
  options: programs.map((id) => ({ id, label: id })),
});

describe("bulk default model Daybreak compatibility", () => {
  it.each([false, true])(
    "keeps Off compatible with a missing descriptor (reversed: %s)",
    (reverse) => {
      const sets = [[descriptor("standard", "daybreakBlue")], []];
      const descriptors = intersectDaybreakDescriptors(reverse ? sets.toReversed() : sets);
      expect(decideDaybreakModelChange([], selection("standard"), descriptors).type).toBe("ready");
      const downgrade = decideDaybreakModelChange(
        selection("daybreakBlue").options,
        { instanceId, model: "other-model" },
        descriptors,
      );
      expect(downgrade.type).toBe("confirm");
      if (downgrade.type !== "confirm") throw new Error("Expected explicit downgrade");
      expect(downgrade.choices.map((choice) => choice.label)).toEqual(["Turn Off"]);
    },
  );

  it("preserves programs advertised on every target and does not invent Off", () => {
    const descriptors = intersectDaybreakDescriptors([
      [descriptor("standard", "daybreakBlue", "daybreakRed")],
      [descriptor("daybreakBlue")],
    ]);
    const compatible = decideDaybreakModelChange(
      selection("daybreakBlue").options,
      { instanceId, model: "other-model" },
      descriptors,
    );
    expect(compatible).toMatchObject({
      type: "ready",
      selection: { options: [{ id: "cyberAccessProgram", value: "daybreakBlue" }] },
    });
    const off = decideDaybreakModelChange([], { instanceId, model: "other-model" }, descriptors);
    expect(off.type).toBe("confirm");
    if (off.type !== "confirm") throw new Error("Expected a program decision");
    expect(off.choices.map((choice) => choice.label)).toEqual(["Use Blue"]);
  });

  it.each([false, true])(
    "does not invent Off when another target requires Daybreak (reversed: %s)",
    (reverse) => {
      const sets = [[], [descriptor("daybreakBlue")]];
      const result = decideDaybreakModelChange(
        [],
        { instanceId, model: "other-model" },
        intersectDaybreakDescriptors(reverse ? sets.toReversed() : sets),
      );
      expect(result).toMatchObject({ type: "confirm", choices: [] });
    },
  );

  it("allows ordinary trait changes while preserving every active program", () => {
    expect(
      blocksBulkDaybreakChange(
        [selection("daybreakBlue"), selection("daybreakBlue")],
        selection("daybreakBlue", "low"),
      ),
    ).toBe(false);
  });

  it("keeps ambiguous model, reset, and Daybreak edits restricted to one target", () => {
    const current = [selection("daybreakBlue"), selection("daybreakBlue")];
    for (const next of [
      null,
      selection("standard"),
      selection("daybreakRed"),
      { ...selection("daybreakBlue"), model: "other-model" },
    ]) {
      expect(blocksBulkDaybreakChange(current, next)).toBe(true);
    }
    expect(
      blocksBulkDaybreakChange(
        [selection("daybreakBlue"), selection("daybreakRed")],
        selection("daybreakBlue", "low"),
      ),
    ).toBe(true);
    expect(blocksBulkDaybreakChange([selection("daybreakBlue")], null)).toBe(false);
    expect(
      blocksBulkDaybreakChange([selection("standard"), selection("standard")], {
        instanceId,
        model: "other-model",
      }),
    ).toBe(false);
  });
});
