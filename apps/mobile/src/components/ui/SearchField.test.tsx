import { act, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const textInput = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children: React.ReactNode; onPress: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
  TextInput: (props: unknown) => textInput(props),
}));
vi.mock("./AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ scale: 1, mediumIconSize: 24 }),
}));

import { SearchField } from "./SearchField";

it("keeps composing text while the workspace header projects a new query, and accepts clears", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const writes: string[] = [];
  let type: (text: string) => void = () => {};
  let setQuery: (text: string) => void = () => {};
  let query = "";
  let field: React.ReactNode = null;
  const listeners = new Set<() => void>();
  const store = {
    get: () => field,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  // React Native TextInput synchronizes mismatched controlled text in a layout effect.
  // A stale query here writes over the native composing span, even at the latest event count.
  textInput.mockImplementation(function NativeInput(props: {
    value: string;
    onChangeText: (text: string) => void;
  }) {
    const [nativeText, setNativeText] = useState(props.value);
    type = (text) => {
      props.onChangeText(text);
      setNativeText(text);
    };
    useLayoutEffect(() => {
      if (nativeText !== props.value) {
        writes.push(props.value);
        setNativeText(props.value);
      }
    }, [nativeText, props.value]);
    return null;
  });
  function Header() {
    return useSyncExternalStore(store.subscribe, store.get, store.get);
  }
  function Screen() {
    const [value, updateQuery] = useState("");
    query = value;
    setQuery = updateQuery;
    const inputRef = useRef(null);
    // WorkspaceAppBar projects a screen's field into its host after each commit.
    useLayoutEffect(() => {
      field = (
        <SearchField
          inputRef={inputRef}
          accessibilityLabel="Search threads"
          clearAccessibilityLabel="Clear search"
          placeholder="Search"
          value={value}
          onChangeText={updateQuery}
        />
      );
      for (const listener of listeners) listener();
    });
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <>
          <Header />
          <Screen />
        </>,
      ),
    );
    for (const text of ["ㅍ", "포", "폴"]) {
      act(() => type(text));
      expect(query).toBe(text);
      expect(writes).toEqual([]);
    }
    act(() => setQuery(""));
    expect(writes).toEqual([""]);
    writes.length = 0;
    act(() => type("폴"));
    act(() => container.querySelector("button")!.click());
    expect(query).toBe("");
    expect(writes).toEqual([""]);
    act(() => setQuery("saved query"));
    expect(writes).toEqual(["", "saved query"]);
  } finally {
    act(() => root.unmount());
  }
});
