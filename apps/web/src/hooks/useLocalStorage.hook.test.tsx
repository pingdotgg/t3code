// @vitest-environment jsdom
import * as Schema from "effect/Schema";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useLocalStorage } from "./useLocalStorage";

const KEY = "corrupt-key";
let root: Root;
let current: ReturnType<typeof useLocalStorage<number, number>>;

function Probe() {
  const result = useLocalStorage(KEY, 0, Schema.Number);
  useEffect(() => {
    current = result;
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  localStorage.setItem(KEY, JSON.stringify("not a number"));
  root = createRoot(document.createElement("div"));
  await act(() => root.render(createElement(Probe)));
});

afterEach(async () => {
  await act(() => root.unmount());
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useLocalStorage with a stored value that fails decode", () => {
  it("replaces it with a plain write", async () => {
    expect(current[0]).toBe(0);

    await act(() => current[1](42));

    expect(localStorage.getItem(KEY)).toBe("42");
    expect(current[0]).toBe(42);
  });

  it("runs an updater from the initial value", async () => {
    await act(() => current[1]((value) => value + 1));

    expect(localStorage.getItem(KEY)).toBe("1");
    expect(current[0]).toBe(1);
  });
});
