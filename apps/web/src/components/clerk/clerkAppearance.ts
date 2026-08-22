import type { ClerkProviderProps } from "@clerk/react";

/** Keeps Clerk's stock component structure while binding its color system to
 * the live T3 Code palette. CSS variables make theme changes propagate to
 * portaled sign-in and profile surfaces without remounting Clerk. */
export const clerkAppearance = {
  variables: {
    // Clerk reuses its primary color for filled buttons and bare links. The
    // app's update foreground is the palette's action hue cast for readable
    // text, while the card surface provides the inverse filled-control pair.
    colorPrimary: "var(--update-foreground)",
    colorPrimaryForeground: "var(--card)",
    colorDanger: "var(--error)",
    colorSuccess: "var(--success)",
    colorWarning: "var(--warning)",
    colorNeutral: "var(--contrast-foreground)",
    colorForeground: "var(--contrast-foreground)",
    // The stock dark theme's muted token is translucent. Clerk uses this as
    // the footer's background, so derive an opaque muted surface from the card.
    colorMuted: "color-mix(in srgb, var(--card) 98%, var(--contrast-foreground))",
    colorMutedForeground: "var(--contrast-muted-foreground)",
    colorBackground: "var(--card)",
    colorInputForeground: "var(--contrast-foreground)",
    colorInput: "var(--secondary)",
    colorRing: "var(--ring)",
  },
  elements: {
    formFieldErrorText: { color: "var(--error-foreground)" },
    formFieldWarningText: { color: "var(--warning-foreground)" },
    formFieldSuccessText: { color: "var(--success-foreground)" },
    otpCodeFieldErrorText: { color: "var(--error-foreground)" },
    otpCodeFieldSuccessText: { color: "var(--success-foreground)" },
  },
} satisfies NonNullable<ClerkProviderProps["appearance"]>;
