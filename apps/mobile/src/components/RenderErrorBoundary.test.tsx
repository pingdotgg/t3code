import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("expo-observe", () => ({ Observe: { reportError: () => {} } }));
vi.mock("react-native", () => ({
  ScrollView: (props: { children?: ReactNode }) => props.children,
  View: (props: { children?: ReactNode }) => props.children,
}));
vi.mock("./ui/AppText", () => ({
  AppText: (props: { children?: ReactNode; selectable?: boolean }) =>
    props.selectable ? <output>{props.children}</output> : null,
}));
vi.mock("./ui/Button", () => ({ Button: () => null }));
vi.mock("../lib/copyTextWithHaptic", () => ({}));

import { RenderFailureView } from "./RenderErrorBoundary";

function preview(details: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<RenderFailureView details={details} retry={() => {}} />));
    return container.querySelector("output")!.textContent!;
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
}

it("keeps the error preview to whole characters at the 300-unit limit", () => {
  expect(preview(`${"a".repeat(299)}😀 more\nstack`)).toBe("a".repeat(299));
  expect(preview(`${"a".repeat(298)}😀 more`)).toBe(`${"a".repeat(298)}😀`);
  expect(preview("b".repeat(400))).toBe("b".repeat(300));
  expect(preview("TypeError: boom 🚀\n    at render")).toBe("TypeError: boom 🚀");
  expect(preview("TypeError: \uD83D")).toBe("TypeError: \uD83D");
});
