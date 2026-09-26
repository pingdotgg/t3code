import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({
    accessibilityElementsHidden,
    importantForAccessibility,
    children,
  }: {
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: string;
    children: ReactNode;
  }) => (
    <span
      aria-hidden={
        accessibilityElementsHidden || importantForAccessibility === "no-hide-descendants"
      }
    >
      {children}
    </span>
  ),
  AppTextInput: ({ accessibilityLabel }: { accessibilityLabel?: string }) => (
    <input aria-label={accessibilityLabel} />
  ),
}));

import { ConnectionFormField } from "./ConnectionFormField";

describe("ConnectionFormField accessibility", () => {
  it.each(["Host", "Pairing code"])("exposes %s once as the input name", (label) => {
    const markup = renderToStaticMarkup(
      <ConnectionFormField label={label} placeholder="Not an accessible name" />,
    );

    expect(markup).toContain(`<span aria-hidden="true">${label}</span>`);
    expect(markup).toContain(`<input aria-label="${label}"/>`);
  });
});
