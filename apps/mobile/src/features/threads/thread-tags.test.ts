import { describe, expect, it } from "vite-plus/test";

import { threadTagPickerRows } from "./thread-tags";

describe("threadTagPickerRows", () => {
  it("lists the thread's tags first, then the rest, narrowed by the query", () => {
    const known = ["alpha", "beta", "gamma"];
    expect(threadTagPickerRows(known, ["gamma", "beta"], "")).toEqual(["beta", "gamma", "alpha"]);
    expect(threadTagPickerRows(known, ["gamma"], " AL")).toEqual(["alpha"]);
    expect(threadTagPickerRows(known, ["gamma"], "ga")).toEqual(["gamma"]);
  });
});
