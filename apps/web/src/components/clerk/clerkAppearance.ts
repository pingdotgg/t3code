import type { ClerkProviderProps } from "@clerk/react";

/** Clerk's styles live in this cascade layer. index.css orders it below
 * Tailwind's components and utilities, so the classes below win over Clerk's
 * own rules without `!important`. */
const CLERK_CSS_LAYER = "clerk";

// Shared recipes, so every Clerk control reads as the matching T3 Code control.
const primaryButton =
  "h-9 sm:h-8 rounded-control surface-lit text-label text-primary-foreground hover:surface-lit-hover focus-visible:outline-2 focus-visible:outline-ring after:hidden before:hidden";
// UserProfile reuses formButtonPrimary for destructive confirmations.
const authFlowElements = { formButtonPrimary: primaryButton };
const secondaryButton =
  "h-9 sm:h-8 rounded-control surface-raised text-label text-foreground hover:surface-raised-hover focus-visible:outline-2 focus-visible:outline-ring";
const ghostButton =
  "rounded-control border-transparent bg-transparent text-label text-foreground shadow-none hover:surface-ghost-hover focus-visible:outline-2 focus-visible:outline-ring";
const field =
  "rounded-control surface-well text-foreground shadow-none placeholder:text-placeholder focus:surface-focus aria-invalid:surface-invalid";
const link = "text-label text-strong-foreground underline-offset-4 hover:underline";
// Menu rows keep Clerk's own color, so destructive rows stay red.
const menuRow =
  "min-h-8 sm:min-h-7 gap-2 rounded-item border-0 px-2 py-1 text-label hover:surface-selected-soft";

/** Live theme variables reach Clerk's portals without remounting them. */
export const clerkAppearance = {
  cssLayerName: CLERK_CSS_LAYER,
  options: {
    logoPlacement: "none",
    shimmer: false,
  },
  variables: {
    // Clerk reuses its primary color for bare links, spinners and checked
    // controls. The redesign keeps those monochrome; filled primary buttons
    // take the lit recipe below instead.
    colorPrimary: "var(--contrast-strong-foreground)",
    colorPrimaryForeground: "var(--popover)",
    colorDanger: "var(--error)",
    colorSuccess: "var(--success)",
    colorWarning: "var(--warning)",
    colorNeutral: "var(--contrast-foreground)",
    colorForeground: "var(--contrast-foreground)",
    colorMuted: "var(--popover)",
    colorMutedForeground: "var(--contrast-muted-foreground)",
    colorBackground: "var(--popover)",
    colorInputForeground: "var(--contrast-foreground)",
    colorInput: "var(--secondary)",
    colorRing: "var(--ring)",
    colorModalBackdrop: "var(--scrim)",
    fontFamily: "var(--font-sans)",
    fontFamilyButtons: "var(--font-sans)",
    fontFamilyMono: "var(--font-mono)",
    fontSize: {
      xs: "var(--type-caption)",
      sm: "var(--type-meta)",
      md: "var(--type-body)",
      lg: "var(--type-label)",
      xl: "var(--type-title)",
    },
    borderRadius: "var(--control-radius)",
  },
  elements: {
    // Modal shells: the dialog surface on the flat scrim.
    modalBackdrop: "dialog-backdrop",
    cardBox: "surface-dialog rounded-pane",
    card: "border-0 bg-transparent shadow-none",
    footer: "border-t border-hairline bg-none bg-transparent",
    modalCloseButton:
      "size-8 rounded-control text-muted-foreground hover:surface-ghost-hover hover:text-foreground",
    header: "items-start text-start",
    headerTitle: "text-title text-strong-foreground",
    headerSubtitle: "text-body text-muted-foreground",
    buttonArrowIcon: "hidden",

    // Sign-in and sign-up forms.
    formButtonPrimary:
      "h-9 sm:h-8 rounded-control text-label focus-visible:outline-2 focus-visible:outline-ring after:hidden before:hidden",
    formButtonReset: ghostButton,
    socialButtonsBlockButton: secondaryButton,
    socialButtonsIconButton: secondaryButton,
    socialButtonsBlockButtonText: "text-label",
    lastAuthenticationStrategyBadge:
      "rounded-badge surface-raised text-micro text-muted-foreground",
    dividerLine: "bg-hairline",
    dividerText: "text-meta text-dim-foreground",
    formFieldLabel: "text-label text-foreground",
    formFieldInput: `h-9 sm:h-8 ${field}`,
    otpCodeFieldInput: field,
    formFieldAction: "text-meta text-muted-foreground hover:text-foreground hover:underline",
    formFieldHintText: "text-meta text-muted-foreground",
    formFieldErrorText: "text-meta text-error-foreground",
    formFieldWarningText: "text-meta text-warning-foreground",
    formFieldSuccessText: "text-meta text-success-foreground",
    otpCodeFieldErrorText: "text-meta text-error-foreground",
    otpCodeFieldSuccessText: "text-meta text-success-foreground",
    footerActionText: "text-body text-muted-foreground",
    footerActionLink: link,
    identityPreview: "rounded-control surface-well shadow-none",
    identityPreviewEditButton: link,
    badge:
      "rounded-badge border border-border bg-transparent text-caption text-muted-foreground shadow-none",

    // The user menu: our menu popover and rows.
    userButtonPopoverCard: "surface-popover rounded-card",
    userButtonPopoverMain: "border-0 bg-transparent shadow-none",
    userButtonPopoverActions: "border-0 p-1",
    userButtonPopoverActionButton: `${menuRow} text-foreground hover:text-strong-foreground`,
    userButtonPopoverActionButtonIconBox: "flex-none basis-auto",
    userButtonPopoverActionButtonIcon: "size-4 text-muted-foreground",
    // Clerk pulls the footer up over the last row; keep the popup's p-1 above its divider.
    userButtonPopoverFooter: "mt-0 border-t border-hairline bg-none bg-transparent",
    // Inset the identity like a menu group label, so it lines up with the rows.
    userPreview__userButton: "px-3 pt-3 pb-2",
    userPreviewMainIdentifier: "text-label text-strong-foreground",
    userPreviewSecondaryIdentifier: "text-meta text-muted-foreground",

    // Account pages: a settings-style nav and rows inside the dialog.
    navbar: "border-e border-hairline bg-none bg-transparent [&_p]:text-meta",
    navbarButton:
      "min-h-8 sm:min-h-7 rounded-item px-2 text-label text-muted-foreground hover:surface-ghost-hover hover:text-foreground [&.cl-active]:surface-selected-soft [&.cl-active]:text-strong-foreground",
    navbarButtonIcon: "size-4",
    scrollBox: "border-0 bg-transparent shadow-none",
    profileSectionTitleText: "text-label text-strong-foreground",
    profileSectionPrimaryButton: "rounded-control text-label",
    menuButton:
      "rounded-control text-muted-foreground hover:surface-ghost-hover hover:text-foreground",
    menuList: "surface-popover rounded-card p-1",
    menuItem: menuRow,
    actionCard: "rounded-card surface-panel",
  },
  signIn: { elements: authFlowElements },
  signUp: { elements: authFlowElements },
} satisfies NonNullable<ClerkProviderProps["appearance"]>;
