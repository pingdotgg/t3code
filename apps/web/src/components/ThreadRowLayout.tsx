import { Fragment, type ReactNode } from "react";
import type {
  SidebarThreadRowComponent,
  SidebarThreadRowPlacement,
} from "@t3tools/contracts/settings";
import { cn } from "../lib/utils";

export const THREAD_ROW_COMPONENT_LABELS = {
  projectIcon: "Project icon",
  title: "Thread title",
  pin: "Pin",
  activity: "Activity (status and time)",
  status: "Status",
  duration: "Working duration",
  project: "Project name",
  environment: "Environment",
  provider: "Provider",
  model: "Model",
  branch: "Branch",
  worktree: "Worktree indicator",
  pullRequest: "Pull request",
  terminal: "Terminal activity",
  updated: "Last message time",
  created: "Created time",
  completed: "Completed time",
  snooze: "Snooze wake time",
} satisfies Record<SidebarThreadRowComponent, string>;

export type ThreadRowLayoutSideProps = {
  row: SidebarThreadRowPlacement["row"];
  alignment: SidebarThreadRowPlacement["alignment"];
  className: string;
  children: ReactNode;
  empty: boolean;
};

export type ThreadRowLayoutRowProps = {
  row: SidebarThreadRowPlacement["row"];
  className: string;
  children: ReactNode;
};

/** Shared geometry for the real list and settings preview. Missing details take no space. */
export function ThreadRowLayout({
  layout,
  components,
  renderSide,
  renderRow,
  showEmptyRows = false,
}: {
  layout: ReadonlyArray<SidebarThreadRowPlacement>;
  components: Partial<Record<SidebarThreadRowComponent, ReactNode>>;
  /** Editor-only wrapper; receives empty sides so details can be placed directly in the sample. */
  renderSide?: (props: ThreadRowLayoutSideProps) => ReactNode;
  renderRow?: (props: ThreadRowLayoutRowProps) => ReactNode;
  showEmptyRows?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      {([1, 2, 3] as const).map((row) => {
        const items = layout.filter(
          (item) => item.row === row && components[item.component] != null,
        );
        if (items.length === 0 && !showEmptyRows) return null;
        const className = "flex min-h-5 w-full min-w-0 items-center gap-2";
        const children = (["left", "right"] as const).map((alignment) => {
          const group = items.filter((item) => item.alignment === alignment);
          if (!group.length && !renderSide) return null;
          const className = cn(
            "flex min-w-0 basis-auto items-center gap-1.5 overflow-hidden",
            alignment === "left" ? "flex-1" : "ml-auto justify-end text-right",
          );
          const children = group.map((item) => (
            <div
              key={item.component}
              className={cn(
                "flex min-w-0 items-center overflow-hidden text-xs text-secondary-label",
                item.component === "title" ? "flex-1" : "shrink",
                alignment === "right" && "justify-end text-right [&>span]:text-right",
              )}
            >
              {components[item.component]}
            </div>
          ));
          return renderSide ? (
            <Fragment key={alignment}>
              {renderSide({ row, alignment, className, children, empty: !group.length })}
            </Fragment>
          ) : (
            <div key={alignment} className={className}>
              {children}
            </div>
          );
        });
        return renderRow ? (
          <Fragment key={row}>{renderRow({ row, className, children })}</Fragment>
        ) : (
          <div key={row} className={className}>
            {children}
          </div>
        );
      })}
    </div>
  );
}
