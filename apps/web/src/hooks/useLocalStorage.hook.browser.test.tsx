import * as Schema from "effect/Schema";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { useLocalStorage } from "./useLocalStorage";

const KEY = "corrupt-key";
type StoredNumber = ReturnType<typeof useLocalStorage<number, number>>;

async function renderWithCorruptValue() {
  await using stack = new AsyncDisposableStack();
  stack.use(vi.spyOn(console, "error").mockImplementation(() => {}));
  localStorage.setItem(KEY, JSON.stringify("not a number"));
  stack.defer(() => localStorage.clear());
  let current: StoredNumber | undefined;
  function Probe() {
    const result = useLocalStorage(KEY, 0, Schema.Number);
    useEffect(() => {
      current = result;
    });
    return null;
  }
  stack.use(await render(<Probe />));
  const environment = stack.move();
  return {
    get current() {
      return current!;
    },
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

describe("useLocalStorage with a stored value that fails decode", () => {
  it("replaces it with a plain write", async () => {
    await using stored = await renderWithCorruptValue();
    expect(stored.current[0]).toBe(0);

    await act(() => stored.current[1](42));

    expect(localStorage.getItem(KEY)).toBe("42");
    expect(stored.current[0]).toBe(42);
  });

  it("runs an updater from the initial value", async () => {
    await using stored = await renderWithCorruptValue();
    await act(() => stored.current[1]((value) => value + 1));

    expect(localStorage.getItem(KEY)).toBe("1");
    expect(stored.current[0]).toBe(1);
  });
});
