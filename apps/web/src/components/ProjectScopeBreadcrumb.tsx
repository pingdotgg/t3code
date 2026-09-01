import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { ContextMenuItem } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { readLocalApi } from "../localApi";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "./WorkspaceBreadcrumb";

const ALL_PROJECTS_MENU_ID = "all";

export interface ProjectScopeBreadcrumbItem {
  readonly id: string;
  readonly label: string;
}

export function ProjectScopeBreadcrumb(props: {
  readonly allLabel?: string | undefined;
  readonly ariaLabel: string;
  readonly items: ReadonlyArray<ProjectScopeBreadcrumbItem>;
  readonly onSelect: (projectKey: string | null) => void;
  readonly rootLabel: string;
  readonly selectedKey: string | null;
  readonly unavailableLabel: string;
}) {
  const selectedLabel =
    props.selectedKey === null
      ? (props.allLabel ?? null)
      : (props.items.find((item) => item.id === props.selectedKey)?.label ?? null);
  const selectionAvailable = props.allLabel !== undefined || props.items.length > 0;
  const openProjectMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const api = readLocalApi();
    if (!api) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const projectKeyByMenuId = new Map<string, string>(
      props.items.map((item, index) => [`project:${index}`, item.id] as const),
    );
    const items: ContextMenuItem<string>[] = [
      ...(props.allLabel
        ? [{ id: ALL_PROJECTS_MENU_ID, label: props.allLabel } satisfies ContextMenuItem<string>]
        : []),
      ...props.items.map((item, index) => ({ id: `project:${index}`, label: item.label })),
    ];
    void settlePromise(() =>
      api.contextMenu.show(items, { x: rect.left, y: rect.bottom + 4 }),
    ).then((clicked) => {
      if (clicked._tag === "Failure" || clicked.value === null) return;
      if (clicked.value === ALL_PROJECTS_MENU_ID) {
        props.onSelect(null);
        return;
      }
      const projectKey = projectKeyByMenuId.get(clicked.value);
      if (projectKey !== undefined) {
        props.onSelect(projectKey);
      }
    });
  };

  return (
    <WorkspaceBreadcrumb ariaLabel={props.ariaLabel}>
      <WorkspaceBreadcrumbItem>{props.rootLabel}</WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator />
      <WorkspaceBreadcrumbItem current>
        {selectedLabel || selectionAvailable ? (
          <button
            type="button"
            aria-haspopup="menu"
            aria-label="Switch project"
            onClick={openProjectMenu}
            className="group/project-title inline-flex min-w-0 max-w-64 cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={
                selectedLabel === null
                  ? "min-w-0 truncate text-muted-foreground"
                  : "min-w-0 truncate"
              }
            >
              {selectedLabel ?? props.unavailableLabel}
            </span>
            <ChevronDownIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/project-title:opacity-100 group-focus-visible/project-title:opacity-100"
            />
          </button>
        ) : (
          <span className="truncate text-muted-foreground">{props.unavailableLabel}</span>
        )}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
