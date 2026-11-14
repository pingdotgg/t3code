import { describe, expect, it } from "vite-plus/test";

import {
  orbitInstanceRemovingText,
  orbitRemoveWaitTextBehindCompletion,
} from "./OrbitInstanceRemove";

describe("orbitInstanceRemovingText", () => {
  it("shows nothing extra while a removal waits for the Instance's setup (Q3)", () => {
    expect(orbitRemoveWaitTextBehindCompletion()).toBeNull();
    expect(orbitInstanceRemovingText({ kind: "waiting" }, true)).toBeNull();
    expect(orbitInstanceRemovingText({ kind: "waiting" })).toBe(
      "Waiting for another removal to finish",
    );
    expect(
      orbitInstanceRemovingText({ kind: "running", step: "Stopping its processes" }, true),
    ).toBe("Stopping its processes");
  });
});
