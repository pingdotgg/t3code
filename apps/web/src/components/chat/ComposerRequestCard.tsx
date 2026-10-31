import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { use, useEffect, useEffectEvent, type ComponentProps, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Kbd } from "../ui/kbd";
import { BackgroundThreadContext } from "./backgroundThread";

function Root(props: Omit<ComponentProps<"div">, "className" | "style">) {
  return (
    <div
      data-slot="composer-request-card"
      className="relative flex w-full min-w-0 flex-col gap-1 rounded-t-2xl p-1 text-meta"
      {...props}
    />
  );
}

/**
 * The 32px title row: tone-colored icon, title, a dim one-line summary, then
 * trailing controls (a counter, a dismiss, or the card's own actions). Render
 * it as a button to make the whole row a disclosure trigger.
 */
function Header({
  icon,
  title,
  sub,
  trailing,
  render,
  ...props
}: Omit<useRender.ComponentProps<"div">, "className" | "style" | "children" | "title"> & {
  icon: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  trailing?: ReactNode;
}) {
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(
      {
        className:
          "flex min-h-8 w-full min-w-0 items-center gap-2 px-2.5 text-start [button&]:cursor-pointer [button&]:rounded-control [button&]:outline-none [button&]:focus-visible:outline-2 [button&]:focus-visible:-outline-offset-2 [button&]:focus-visible:outline-ring",
        children: (
          <>
            <span aria-hidden className="flex shrink-0 items-center [&>svg]:size-[13px]">
              {icon}
            </span>
            <span className="shrink-0 text-label text-foreground">{title}</span>
            <span className="min-w-0 flex-1 truncate text-dim-foreground">{sub}</span>
            {trailing ? <span className="flex shrink-0 items-center gap-1">{trailing}</span> : null}
          </>
        ),
      },
      props,
    ),
  });
}

/** Buttons a card puts in its header row instead of a footer, spaced like the footer's. */
function Actions({ children }: { children: ReactNode }) {
  return <span className="flex items-center gap-2">{children}</span>;
}

/** A dim "1/3" position among several pending requests. */
function Counter({ index, total }: { index: number; total: number }) {
  return (
    <span className="text-dim-foreground tabular-nums">
      {index}/{total}
    </span>
  );
}

/** Content under the header, such as the question being asked. */
function Body({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-0.5 pb-1 text-body text-foreground">{children}</div>;
}

/**
 * The inset well that holds the command, file list or options. `options`
 * tightens it around a list of selectable option rows.
 */
function Well({
  density = "default",
  ...props
}: Omit<ComponentProps<"div">, "className" | "style"> & { density?: "default" | "options" }) {
  return (
    <div className="px-1.5">
      <div
        className={cn(
          "flex min-w-0 flex-col rounded-control surface-well",
          density === "options" && "gap-0 p-1",
        )}
        {...props}
      />
    </div>
  );
}

function Footer(props: Omit<ComponentProps<"div">, "className" | "style">) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center justify-end gap-2 py-1.5 ps-2.5 pe-1.5"
      {...props}
    />
  );
}

function Spacer() {
  return <span aria-hidden className="min-w-0 flex-1" />;
}

/** The Enter key cap on a card's primary action. */
function EnterKey() {
  return <Kbd aria-hidden>⏎</Kbd>;
}

export const ComposerRequestCard = {
  Root,
  Header,
  Actions,
  Counter,
  Body,
  Well,
  Footer,
  Spacer,
  EnterKey,
};

/**
 * Enter runs a card's primary action while nothing else has focus. Focused
 * controls keep Enter for themselves, and the composer routes its own Enter.
 */
export function useRequestCardEnterShortcut(action: (() => void) | null) {
  const backgroundThread = use(BackgroundThreadContext);
  const runAction = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (!action) return;
    event.preventDefault();
    action();
  });
  const enabled = action !== null && !backgroundThread;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Body-focus Enter has no card target, so the active foreground card owns a document listener.
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Enter" || event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.target !== document.body && event.target !== document.documentElement) return;
      runAction(event);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled]);
}
