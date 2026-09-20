import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  FIT_TABLES_STORAGE_KEY,
  useFitTables,
  THREAD_WIDTH_STORAGE_KEY,
  useThreadWidth,
} from "./useThreadWidth";

let renderer: ReactTestRenderer | undefined;
let saved: Map<string, string>;
let events: EventTarget;
let current: ReturnType<typeof useThreadWidth>;
let other: ReturnType<typeof useThreadWidth>;

function Reader({ secondary = false }: { secondary?: boolean }) {
  const value = useThreadWidth();
  useEffect(() => {
    if (secondary) other = value;
    else current = value;
  }, [secondary, value]);
  return null;
}

beforeEach(() => {
  saved = new Map();
  events = new EventTarget();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    localStorage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    },
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("starts at the original width and shares changes between the toolbar and conversation", async () => {
  await act(() => {
    renderer = create(
      <>
        <Reader />
        <Reader secondary />
      </>,
    );
  });
  expect(current[0]).toBe(0);
  await act(() => current[1](5));
  expect(other[0]).toBe(5);
  expect(saved.get(THREAD_WIDTH_STORAGE_KEY)).toBe("5");
  await act(() => other[1](100));
  expect(current[0]).toBe(100);
  await act(() => current[1](0));
  expect(other[0]).toBe(0);
});

it("retains the preference when navigating or restarting the client", async () => {
  await act(() => {
    renderer = create(<Reader />);
  });
  await act(() => current[1](65));
  await act(() => renderer!.unmount());
  await act(() => {
    renderer = create(<Reader />);
  });
  expect(current[0]).toBe(65);
});

it("follows a preference changed by another window", async () => {
  await act(() => {
    renderer = create(<Reader />);
  });
  saved.set(THREAD_WIDTH_STORAGE_KEY, "85");
  await act(() => {
    const event = new Event("storage");
    Object.defineProperty(event, "key", { value: THREAD_WIDTH_STORAGE_KEY });
    events.dispatchEvent(event);
  });
  expect(current[0]).toBe(85);
});

it.each([
  { value: -20, expected: 0 },
  { value: 123, expected: 100 },
  { value: 32, expected: 30 },
  { value: null, expected: 0 },
  { value: "wide", expected: 0 },
  { value: {}, expected: 0 },
])(
  "keeps invalid stored width $value usable and accepts a subsequent adjustment",
  async ({ value, expected }) => {
    saved.set(THREAD_WIDTH_STORAGE_KEY, JSON.stringify(value));
    await act(() => {
      renderer = create(<Reader />);
    });
    expect(current[0]).toBe(expected);
    await act(() => current[1](55));
    expect(current[0]).toBe(55);
    expect(saved.get(THREAD_WIDTH_STORAGE_KEY)).toBe("55");
  },
);

it("clamps controls at the endpoints and quantizes every adjustment to five percent", async () => {
  await act(() => {
    renderer = create(<Reader />);
  });
  for (const [input, expected] of [
    [-5, 0],
    [105, 100],
    [27, 25],
    [28, 30],
    [95, 95],
  ]) {
    await act(() => current[1](input!));
    expect(current[0]).toBe(expected);
  }
});

let fit: ReturnType<typeof useFitTables>;
let otherFit: ReturnType<typeof useFitTables>;
function FitReader({ secondary = false }: { secondary?: boolean }) {
  const value = useFitTables();
  useEffect(() => {
    if (secondary) otherFit = value;
    else fit = value;
  }, [secondary, value]);
  return null;
}
it("fits tables by default and synchronizes existing tables with the toolbar", async () => {
  await act(() => {
    renderer = create(
      <>
        <FitReader />
        <FitReader secondary />
        <Reader />
      </>,
    );
  });
  expect(fit[0]).toBe(true);
  await act(() => fit[1](false));
  expect(otherFit[0]).toBe(false);
  expect(saved.get(FIT_TABLES_STORAGE_KEY)).toBe("false");
  expect(current[0]).toBe(0);
  await act(() => otherFit[1](true));
  expect(fit[0]).toBe(true);
});
it("preserves an explicit Fit tables off choice across navigation and restart", async () => {
  await act(() => {
    renderer = create(<FitReader />);
  });
  await act(() => fit[1](false));
  await act(() => renderer!.unmount());
  await act(() => {
    renderer = create(<FitReader />);
  });
  expect(fit[0]).toBe(false);
});
it("updates tables when another window changes the fit preference", async () => {
  await act(() => {
    renderer = create(<FitReader />);
  });
  saved.set(FIT_TABLES_STORAGE_KEY, "false");
  await act(() => {
    const event = new Event("storage");
    Object.defineProperty(event, "key", { value: FIT_TABLES_STORAGE_KEY });
    events.dispatchEvent(event);
  });
  expect(fit[0]).toBe(false);
});
it.each(["{}", "null", '"false"'])(
  "defaults safely with invalid Fit tables storage %s",
  async (value) => {
    saved.set(FIT_TABLES_STORAGE_KEY, value);
    await act(() => {
      renderer = create(<FitReader />);
    });
    expect(fit[0]).toBe(true);
    await act(() => fit[1](false));
    expect(fit[0]).toBe(false);
  },
);
