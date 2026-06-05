import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

// Mirrors Clerk's raised card/footer/branding composition for the desktop-native flow:
// https://github.com/clerk/javascript/blob/52861184477bee99c71552000311a289e91d3b59/packages/ui/src/elements/Card/CardRoot.tsx
// https://github.com/clerk/javascript/blob/52861184477bee99c71552000311a289e91d3b59/packages/ui/src/elements/Card/CardFooter.tsx
// https://github.com/clerk/javascript/blob/52861184477bee99c71552000311a289e91d3b59/packages/ui/src/elements/Card/CardClerkAndPagesTag.tsx
// https://github.com/clerk/javascript/blob/52861184477bee99c71552000311a289e91d3b59/packages/ui/src/elements/DevModeNotice.tsx
export function DesktopClerkCard({
  children,
  footerAction,
}: {
  children: ReactNode;
  footerAction?: ReactNode;
}) {
  return (
    <div className="isolate w-full max-w-[25rem] overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-[0_12px_28px_rgba(0,0,0,0.12)]">
      <div className="relative -m-px flex flex-col gap-8 rounded-lg border border-border/80 bg-card px-10 py-8 text-center">
        {children}
      </div>
      <div className="-mt-2 flex flex-col bg-muted/45 pt-2">
        {footerAction ? (
          <div className="border-t border-border/70 px-8 py-4">{footerAction}</div>
        ) : null}
        <DesktopClerkBranding />
      </div>
    </div>
  );
}

export function DesktopClerkHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-xl font-bold tracking-[-0.025em] text-foreground">{title}</h2>
      <p className="text-sm leading-5 text-muted-foreground">{subtitle}</p>
    </div>
  );
}

export function DesktopClerkFooterAction({
  children,
  actionLabel,
  onAction,
}: {
  children: ReactNode;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <p className="flex items-center justify-center gap-1 text-sm text-muted-foreground">
      <span>{children}</span>
      <button
        type="button"
        className="cursor-pointer font-semibold text-foreground outline-none hover:underline focus-visible:underline"
        onClick={onAction}
      >
        {actionLabel}
      </button>
    </p>
  );
}

export function DesktopClerkAlert({ children }: { children?: ReactNode }) {
  if (!children) return null;

  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/20 bg-destructive/8 px-3 py-2 text-left text-xs leading-5 text-destructive-foreground"
    >
      {children}
    </div>
  );
}

export function DesktopClerkInput({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"input">) {
  return (
    <input
      {...props}
      className={cn(
        "h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none placeholder:text-muted-foreground/80 focus:border-ring focus:ring-2 focus:ring-ring/15 disabled:opacity-64",
        className,
      )}
    />
  );
}

export function DesktopClerkPrimaryButton({
  children,
  disabled,
}: {
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="h-10 w-full cursor-pointer rounded-md border border-neutral-950 bg-neutral-900 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-neutral-800 disabled:pointer-events-none disabled:opacity-64 dark:border-neutral-200 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
    >
      {children}
    </button>
  );
}

function DesktopClerkBranding() {
  const isDevelopmentMode = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_");

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 border-t border-border/70 px-8 py-4 text-xs text-muted-foreground",
        isDevelopmentMode &&
          "bg-[repeating-linear-gradient(-45deg,rgba(249,115,22,0.035),rgba(249,115,22,0.035)_8px,transparent_8px,transparent_16px)]",
      )}
    >
      <span>
        Secured by{" "}
        <a
          className="font-bold text-muted-foreground hover:text-foreground"
          href="https://go.clerk.com/components"
          rel="noreferrer"
          target="_blank"
        >
          clerk
        </a>
      </span>
      {isDevelopmentMode ? (
        <strong className="font-semibold text-orange-500">Development mode</strong>
      ) : null}
    </div>
  );
}
