import { describe, expect, it } from "vite-plus/test";

import { clerkAppearance } from "./clerkAppearance";

describe("clerkAppearance", () => {
  it("maps theme colors without overriding Clerk's component structure", () => {
    expect(clerkAppearance).toEqual({
      variables: {
        colorPrimary: "var(--primary)",
        colorPrimaryForeground: "var(--primary-foreground)",
        colorDanger: "var(--destructive)",
        colorSuccess: "var(--success)",
        colorWarning: "var(--warning)",
        colorNeutral: "var(--foreground)",
        colorForeground: "var(--foreground)",
        colorMuted: "color-mix(in srgb, var(--card) 98%, var(--foreground))",
        colorMutedForeground: "var(--muted-foreground)",
        colorBackground: "var(--card)",
        colorInputForeground: "var(--foreground)",
        colorInput: "var(--secondary)",
        colorRing: "var(--ring)",
      },
      elements: {
        formFieldErrorText: { color: "var(--destructive-foreground)" },
        formFieldWarningText: { color: "var(--warning-foreground)" },
        formFieldSuccessText: { color: "var(--success-foreground)" },
        otpCodeFieldErrorText: { color: "var(--destructive-foreground)" },
        otpCodeFieldSuccessText: { color: "var(--success-foreground)" },
      },
    });
  });
});
