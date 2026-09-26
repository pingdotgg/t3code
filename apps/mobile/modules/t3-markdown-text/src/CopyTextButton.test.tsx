import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  alert: vi.fn(),
  impactAsync: vi.fn(),
  setStringAsync: vi.fn(),
  pressableProps: {
    current: null as null | {
      onPress?: () => void;
      accessibilityLabel?: string;
      disabled?: boolean;
    },
  },
}));

vi.mock("react-native", () => ({
  Alert: { alert: mocks.alert },
  Pressable: (props: { onPress?: () => void; accessibilityLabel?: string; disabled?: boolean }) => {
    mocks.pressableProps.current = props;
    return null;
  },
}));

vi.mock("expo-clipboard", () => ({
  setStringAsync: mocks.setStringAsync,
}));

vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light" },
  impactAsync: mocks.impactAsync,
}));

vi.mock("expo-symbols", () => ({
  SymbolView: () => null,
}));

import { CopyTextButton } from "./CopyTextButton";

let root: Root;

function buttonProps() {
  return {
    accessibilityLabel: "Copy code",
    text: "const answer = 42;",
    tintColor: "#fff",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.impactAsync.mockResolvedValue(undefined);
  mocks.setStringAsync.mockReturnValue(new Promise<void>(() => undefined));
  mocks.pressableProps.current = null;
  const document = {
    nodeType: 9,
    addEventListener() {},
    removeEventListener() {},
  };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CopyTextButton", () => {
  it("keeps the original label while the write is pending, then shows Copied", async () => {
    let resolveWrite!: (value: boolean) => void;
    mocks.setStringAsync.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveWrite = resolve;
      }),
    );
    await act(async () => {
      root.render(createElement(CopyTextButton, buttonProps()));
    });

    await act(async () => {
      mocks.pressableProps.current?.onPress?.();
    });

    // The tap haptic answers immediately; the Copied label waits on the write.
    expect(mocks.impactAsync).toHaveBeenCalledWith("light");
    expect(mocks.pressableProps.current?.accessibilityLabel).toBe("Copy code");

    await act(async () => {
      resolveWrite(true);
    });

    expect(mocks.pressableProps.current?.accessibilityLabel).toBe("Copied");
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("alerts on a refused write, never shows Copied, and retries the same text", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.setStringAsync
      .mockRejectedValueOnce(new Error("native clipboard failure"))
      .mockResolvedValueOnce(true);
    await act(async () => {
      root.render(createElement(CopyTextButton, buttonProps()));
    });

    await act(async () => {
      mocks.pressableProps.current?.onPress?.();
    });

    expect(mocks.alert).toHaveBeenCalledWith("Could not copy", "Try again.");
    expect(mocks.pressableProps.current?.accessibilityLabel).toBe("Copy code");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("const answer = 42;");

    await act(async () => {
      mocks.pressableProps.current?.onPress?.();
    });

    expect(mocks.setStringAsync).toHaveBeenNthCalledWith(2, "const answer = 42;");
    expect(mocks.pressableProps.current?.accessibilityLabel).toBe("Copied");
  });
});

for (const outcome of [true, false]) {
  it(`ignores a late ${outcome} outcome after the text changes`, async () => {
    let finish!: (value: boolean) => void;
    mocks.setStringAsync.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    await act(() => root.render(createElement(CopyTextButton, buttonProps())));
    await act(() => mocks.pressableProps.current?.onPress?.());
    await act(() =>
      root.render(createElement(CopyTextButton, { ...buttonProps(), text: "new text" })),
    );
    await act(() => finish(outcome));
    expect(mocks.pressableProps.current?.accessibilityLabel).toBe("Copy code");
    expect(mocks.alert).not.toHaveBeenCalled();
  });
}
it("reports a false write result as failure", async () => {
  mocks.setStringAsync.mockResolvedValueOnce(false);
  await act(() => root.render(createElement(CopyTextButton, buttonProps())));
  await act(() => mocks.pressableProps.current?.onPress?.());
  expect(mocks.alert).toHaveBeenCalledWith("Could not copy", "Try again.");
  expect(mocks.pressableProps.current?.accessibilityLabel).toBe("Copy code");
});
it("ignores an older write after a newer attempt fails", async () => {
  let finish!: (value: boolean) => void;
  mocks.setStringAsync
    .mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValueOnce(false);
  await act(() => root.render(createElement(CopyTextButton, buttonProps())));
  await act(() => mocks.pressableProps.current?.onPress?.());
  await act(() => mocks.pressableProps.current?.onPress?.());
  await act(() => finish(true));
  expect(mocks.pressableProps.current?.accessibilityLabel).toBe("Copy code");
  expect(mocks.alert).toHaveBeenCalledTimes(1);
});
it("does not show a late failure after unmount", async () => {
  let finish!: (value: boolean) => void;
  mocks.setStringAsync.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  await act(() => root.render(createElement(CopyTextButton, buttonProps())));
  await act(() => mocks.pressableProps.current?.onPress?.());
  await act(() => root.render(null));
  await act(() => finish(false));
  expect(mocks.alert).not.toHaveBeenCalled();
});
