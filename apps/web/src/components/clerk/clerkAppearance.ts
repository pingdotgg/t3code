import type { ClerkProviderProps } from "@clerk/react";

// Scoped to auth flows: UserProfile reuses formButtonPrimary for destructive confirmations.
const authFlowElements = {
  formButtonPrimary:
    "border-primary bg-primary bg-none text-primary-foreground shadow-xs shadow-primary/24 hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
};

export const clerkAppearance = {
  // index.css orders this layer below components and utilities so the element classes below win.
  cssLayerName: "clerk",
  options: { shimmer: false },
  variables: {
    borderRadius: "0.5rem",
    // Clerk reuses its primary color for filled buttons and bare links.
    colorPrimary: "var(--update-foreground)",
    colorPrimaryForeground: "var(--card)",
    colorDanger: "var(--error)",
    colorSuccess: "var(--success)",
    colorWarning: "var(--warning)",
    colorNeutral: "var(--contrast-foreground)",
    colorForeground: "var(--contrast-foreground)",
    // Clerk's muted token fills the footer; derive an opaque surface instead of stock dark translucency.
    colorMuted: "color-mix(in srgb, var(--card) 98%, var(--contrast-foreground))",
    colorMutedForeground: "var(--contrast-muted-foreground)",
    colorBackground: "var(--card)",
    colorInputForeground: "var(--contrast-foreground)",
    colorInput: "var(--secondary)",
    colorRing: "var(--ring)",
  },
  elements: {
    modalBackdrop: "dialog-backdrop",
    cardBox: "dialog-glass rounded-2xl border",
    card: "border-0 bg-transparent shadow-none",
    footer: "bg-transparent bg-none",
    header: "items-start text-start",
    headerTitle: "text-xl font-semibold",
    headerSubtitle: "text-sm text-muted-foreground",
    buttonArrowIcon: "hidden",
    formFieldErrorText: { color: "var(--error-foreground)" },
    formFieldWarningText: { color: "var(--warning-foreground)" },
    formFieldSuccessText: { color: "var(--success-foreground)" },
    otpCodeFieldErrorText: { color: "var(--error-foreground)" },
    otpCodeFieldSuccessText: { color: "var(--success-foreground)" },
  },
  signIn: { elements: authFlowElements },
  signUp: { elements: authFlowElements },
} satisfies NonNullable<ClerkProviderProps["appearance"]>;
