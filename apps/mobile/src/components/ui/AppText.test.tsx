import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: process.env.T3_MOBILE_TEST_PLATFORM ?? "ios" },
  Text: (props: { readonly style?: unknown; readonly children?: string }) => (
    <span data-style={JSON.stringify(props.style ?? null)}>{props.children}</span>
  ),
  TextInput: () => null,
}));

import { AppText } from "./AppText";

function renderText(node: React.ReactNode) {
  const host = document.createElement("div");
  act(() => createRoot(host).render(node));
  const span = host.querySelector("span")!;
  return { text: span.textContent, style: JSON.parse(span.dataset.style!) };
}

it("sets the writing direction from plain-string text", () => {
  expect(renderText(<AppText>סיכום פגישה: Roadmap</AppText>).style).toEqual([
    { writingDirection: "rtl" },
    null,
  ]);
  expect(renderText(<AppText>Weekly review</AppText>).style).toEqual([
    { writingDirection: "ltr" },
    null,
  ]);
  expect(renderText(<AppText>12:30</AppText>).style).toBeNull();
});

it("lets an explicit style win and leaves non-string children alone", () => {
  expect(renderText(<AppText style={{ writingDirection: "ltr" }}>שלום</AppText>).style).toEqual([
    { writingDirection: "rtl" },
    { writingDirection: "ltr" },
  ]);
  expect(renderText(<AppText>{["שלום", " 3"]}</AppText>).style).toBeNull();
});

// Metro inlines Platform.OS, so this branch runs under T3_MOBILE_TEST_PLATFORM=android.
it("marks the direction only for Android, which ignores writingDirection", () => {
  const android = process.env.T3_MOBILE_TEST_PLATFORM === "android";
  expect(renderText(<AppText>שלום world</AppText>).text).toBe(
    android ? "\u200fשלום world" : "שלום world",
  );
});
