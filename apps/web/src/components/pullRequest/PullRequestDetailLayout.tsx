import { ArrowLeftIcon, FileDiffIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PullRequestMetaLine } from "./pullRequestPresentation";

export function PullRequestDetailHeaderBody({
  title,
  author,
  updated,
  checkout,
  base,
  head,
  files,
  diffStat,
}: {
  title: ReactNode;
  author: ReactNode;
  updated: ReactNode;
  checkout?: ReactNode;
  base: ReactNode;
  head: ReactNode;
  files: ReactNode;
  diffStat: ReactNode;
}) {
  return (
    <div className="col-span-2 mt-1 min-w-0 px-4 pb-4">
      {title}
      <div className="mt-2 flex min-h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <PullRequestMetaLine className="min-w-0 whitespace-nowrap">
          {author}
          {updated}
        </PullRequestMetaLine>
        {checkout}
      </div>
      <div className="mt-4 flex min-h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-xs text-muted-foreground/70">
          {base}
          <ArrowLeftIcon
            aria-label="receives changes from"
            className="size-3.5 shrink-0 opacity-60"
          />
          {head}
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center justify-end gap-2">
          <span className="inline-flex min-w-16 items-center justify-end gap-1.5 tabular-nums">
            <FileDiffIcon aria-hidden className="size-3.5" />
            {files}
          </span>
          {diffStat}
        </span>
      </div>
    </div>
  );
}

export function PullRequestDetailTitleRow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("flex min-h-7 min-w-0 items-center sm:min-h-6", className)} {...props} />
  );
}

export function PullRequestDetailTabBar<Tab extends string>({
  tabs,
  value,
  onValueChange,
  onTabIntent,
  inert,
  children,
}: {
  tabs: ReadonlyArray<{ readonly value: Tab; readonly label: string }>;
  value: Tab;
  onValueChange?: (tab: Tab) => void;
  onTabIntent?: (tab: Tab) => void;
  inert?: boolean;
  children?: ReactNode;
}) {
  return (
    <nav
      className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 border-t border-border/60 px-4 py-2"
      aria-label="Pull request tabs"
      inert={inert}
    >
      <ToggleGroup
        className="shrink-0"
        size="segmented"
        variant="segmented"
        value={[value]}
        onValueChange={(next) => {
          const nextTab = tabs.find((item) => item.value === next[0])?.value;
          if (nextTab) onValueChange?.(nextTab);
        }}
      >
        {tabs.map((tab) => (
          <Toggle
            key={tab.value}
            value={tab.value}
            onPointerEnter={onTabIntent ? () => onTabIntent(tab.value) : undefined}
            onFocus={onTabIntent ? () => onTabIntent(tab.value) : undefined}
          >
            {tab.label}
          </Toggle>
        ))}
      </ToggleGroup>
      {children}
    </nav>
  );
}

export function PullRequestChecksStatusLine({
  icon,
  label,
  className,
  ...props
}: Omit<ComponentProps<"span">, "children"> & { icon: ReactNode; label: ReactNode }) {
  return (
    <span
      className={cn(
        "ml-auto flex h-4 min-w-0 flex-1 flex-wrap content-start items-center justify-end gap-x-1.5 overflow-hidden text-xs",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="whitespace-nowrap">{label}</span>
    </span>
  );
}
