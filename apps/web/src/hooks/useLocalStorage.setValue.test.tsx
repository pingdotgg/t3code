import * as Schema from "effect/Schema";
import { act, createElement, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useLocalStorage } from "./useLocalStorage";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

type SetNumber = (value: number | ((val: number) => number)) => void;

interface Captured {
  value: number;
  setValue: SetNumber;
}

function Probe({ captured }: { captured: Captured }) {
  const [value, setValue] = useLocalStorage("probe-key", 0, Schema.Number);
  useLayoutEffect(() => {
    captured.value = value;
    captured.setValue = setValue;
  });
  return null;
}

function stubHookWindow(storage: Storage) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  vi.stubGlobal(
    "CustomEvent",
    class {
      type: string;
      detail: unknown;
      constructor(type: string, options?: { detail?: unknown }) {
        this.type = type;
        this.detail = options?.detail;
      }
    },
  );
  vi.stubGlobal("window", {
    localStorage: storage,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const set = listeners.get(type) ?? new Set<(event: unknown) => void>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: { type: string }) => {
      listeners.get(event.type)?.forEach((listener) => listener(event));
      return true;
    },
  });
}

let renderer: ReactTestRenderer | undefined;
let captured: Captured;

function renderProbe() {
  captured = { value: -1, setValue: () => {} };
  act(() => {
    renderer = create(createElement(Probe, { captured }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = undefined;
  }
  vi.unstubAllGlobals();
});

describe("useLocalStorage setValue with an undecodable stored blob", () => {
  it("still writes a plain value and heals the stored blob", () => {
    const storage = createStorage();
    // Valid JSON, but not a number: the read path falls back to the initial
    // value while the write path used to die here.
    storage.setItem("probe-key", JSON.stringify("not-a-number"));
    stubHookWindow(storage);
    renderProbe();

    expect(captured.value).toBe(0);

    act(() => {
      captured.setValue(42);
    });

    expect(storage.getItem("probe-key")).toBe(JSON.stringify(42));
    expect(captured.value).toBe(42);
  });

  it("runs an updater against the initial value when the stored blob is undecodable", () => {
    const storage = createStorage();
    storage.setItem("probe-key", JSON.stringify({ unexpected: "shape" }));
    stubHookWindow(storage);
    renderProbe();

    act(() => {
      captured.setValue((n) => n + 1);
    });

    expect(storage.getItem("probe-key")).toBe(JSON.stringify(1));
    expect(captured.value).toBe(1);
  });

  it("keeps the normal write and updater paths working", () => {
    const storage = createStorage();
    stubHookWindow(storage);
    renderProbe();

    act(() => {
      captured.setValue(7);
    });
    expect(storage.getItem("probe-key")).toBe(JSON.stringify(7));
    expect(captured.value).toBe(7);

    act(() => {
      captured.setValue((n) => n * 2);
    });
    expect(storage.getItem("probe-key")).toBe(JSON.stringify(14));
    expect(captured.value).toBe(14);
  });
});
