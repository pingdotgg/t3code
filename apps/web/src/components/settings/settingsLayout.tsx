import { Undo2Icon } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { useLocation } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { settingsSearchId } from "./settingsSearch";

const SettingsTargetContext = createContext("");

function focusSettingsTarget(target: HTMLElement) {
  target.scrollIntoView({ block: "nearest", behavior: "instant" });
  target.focus({ preventScroll: true });
}

export function scrollToSettingsTarget(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  focusSettingsTarget(target);
}

function useSettingsTarget(id: string) {
  const targetId = useContext(SettingsTargetContext);
  return useCallback(
    (element: HTMLElement | null) => {
      if (element && targetId && targetId === id) focusSettingsTarget(element);
    },
    [id, targetId],
  );
}

/** Re-render every `intervalMs`; return a stable timestamp snapshot for render-time relative labels. */
export function useRelativeTimeTick(intervalMs = 1_000) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}

export function SettingsSection({
  title,
  description,
  icon,
  headerAction,
  children,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  const id = `section-${settingsSearchId(title).slice("setting-".length)}`;
  const targetRef = useSettingsTarget(id);
  return (
    <section
      ref={targetRef}
      id={id}
      tabIndex={-1}
      className="space-y-2.5 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="flex items-start justify-between gap-3 px-1">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
            <span className="inline-block h-px w-3 bg-border" aria-hidden />
            {icon}
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">{description}</p>
          ) : null}
        </div>
        {headerAction ? <div className="flex shrink-0 items-center">{headerAction}</div> : null}
      </div>
      <div className="relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm/4 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:shadow-none dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  children,
}: {
  title: ReactNode;
  description: string;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  const id = typeof title === "string" ? settingsSearchId(title) : undefined;
  const targetRef = useSettingsTarget(id ?? "");
  return (
    <div
      ref={targetRef}
      id={id}
      tabIndex={id ? -1 : undefined}
      className={`border-t border-border/60 px-4 pt-4 first:border-t-0 sm:px-5${
        children ? "" : " pb-4"
      } focus-visible:outline-2 focus-visible:outline-ring`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
              {title}
            </h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground/80">{description}</p>
          {status ? <div className="pt-0.5 text-[11px] text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SettingResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Reset ${label} to default`}
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">Reset to default</TooltipPopup>
    </Tooltip>
  );
}

export function SettingsPageContainer({
  children,
  width = "narrow",
}: {
  children: ReactNode;
  width?: "narrow" | "wide";
}) {
  const hash = useLocation({ select: (location) => location.hash });

  return (
    <SettingsTargetContext value={hash.replace(/^#/, "")}>
      <div className="scrollbar-gutter-both flex-1 overflow-y-auto p-6 sm:p-8">
        <div
          className={
            width === "wide"
              ? "mx-auto flex w-full max-w-4xl flex-col gap-8"
              : "mx-auto flex w-full max-w-3xl flex-col gap-8"
          }
        >
          {children}
        </div>
      </div>
    </SettingsTargetContext>
  );
}

export function SettingsPageHeader({
  title,
  description,
  status,
}: {
  title: string;
  description: string;
  status?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-[-0.01em] text-foreground">{title}</h1>
        <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      {status ? <div className="flex shrink-0 flex-wrap items-center gap-1.5">{status}</div> : null}
    </div>
  );
}
