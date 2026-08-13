import type { ClerkProviderProps } from "@clerk/react";

/** Keeps Clerk's stock component structure while binding its color system to
 * the live T3 Code palette. CSS variables make theme changes propagate to
 * portaled sign-in and profile surfaces without remounting Clerk. */
export const clerkAppearance = {
  variables: {
    // Clerk reuses its primary color for filled buttons and bare links. Bind
    // both to this tree's action tokens; later nightlies use --update-* /
    // --error from the theme library we have not ported.
    colorPrimary: "var(--primary)",
    colorPrimaryForeground: "var(--primary-foreground)",
    colorDanger: "var(--destructive)",
    colorSuccess: "var(--success)",
    colorWarning: "var(--warning)",
    colorNeutral: "var(--foreground)",
    colorForeground: "var(--foreground)",
    // The stock dark theme's muted token is translucent. Clerk uses this as
    // the footer's background, so derive an opaque muted surface from the card.
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
} satisfies NonNullable<ClerkProviderProps["appearance"]>;
