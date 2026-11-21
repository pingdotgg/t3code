import { describe, expect, it } from "vite-plus/test";

import { soloMixerKey, toggleMixerKey } from "./mixerSelection";

const keys = ["a", "b", "c"];

describe("toggleMixerKey", () => {
  it("turns one key off from all", () => {
    expect(toggleMixerKey(keys, null, "b")).toEqual(["a", "c"]);
  });

  it("returns to all when the last off key turns back on", () => {
    expect(toggleMixerKey(keys, ["c", "a"], "b")).toBeNull();
  });

  it("keeps universe order and drops keys outside it", () => {
    expect(toggleMixerKey(keys, ["c", "gone"], "a")).toEqual(["a", "c"]);
  });

  it("returns an empty selection when the last on key turns off", () => {
    expect(toggleMixerKey(keys, ["b"], "b")).toEqual([]);
  });
});

describe("soloMixerKey", () => {
  it("solos a key from all", () => {
    expect(soloMixerKey(keys, null, "b")).toEqual(["b"]);
  });

  it("unsolos the soloed key back to all", () => {
    expect(soloMixerKey(keys, ["b"], "b")).toBeNull();
  });

  it("moves the solo to another key", () => {
    expect(soloMixerKey(keys, ["b"], "c")).toEqual(["c"]);
  });

  it("solos an on key when several are on", () => {
    expect(soloMixerKey(keys, ["a", "b"], "a")).toEqual(["a"]);
  });
});
