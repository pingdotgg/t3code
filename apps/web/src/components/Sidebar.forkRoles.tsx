import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ForkRole } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { BotIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { createElement, lazy, Suspense, useState } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { cn } from "../lib/utils";
import { useForkRole, useForkRolesPrefetch } from "../state/forkRoles";
import { resolveRolesSection } from "./Sidebar.forkRoles.logic";
import { SortableSidebarMarker } from "./sidebar/SidebarListMarkers";
import { CollapsibleSectionHeader } from "./ui/collapsible-section-header";
import { Spinner } from "./ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const ROLES_EXPANDED_KEY = "t3code:sidebar:roles-expanded";

export function useRolesSection(
  roles: readonly EnvironmentThreadShell[],
  routeThreadKey: string | null,
) {
  const [expanded, setExpanded] = useLocalStorage(ROLES_EXPANDED_KEY, true, Schema.Boolean);
  const [showAll, setShowAll] = useState(false);
  useForkRolesPrefetch();
  const section = resolveRolesSection(roles, { expanded, showAll, routeThreadKey });
  return {
    ...section,
    threads: roles,
    expanded,
    showAll,
    dimmedKeys: new Set(
      section.rows.flatMap(({ thread, dimmed }) =>
        dimmed ? [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))] : [],
      ),
    ),
    toggle: () => setExpanded((value) => !value),
    toggleShowAll: () => setShowAll((value) => !value),
  };
}

export function RolesHeader(props: { readonly section: ReturnType<typeof useRolesSection> }) {
  const { section } = props;
  const gt = useGT();
  const showAllLabel = section.showAll
    ? gt("Hide quiet roles", { $context: "sidebar roles section" })
    : gt("Show all roles", { $context: "sidebar roles section" });
  return (
    <SortableSidebarMarker
      marker="roles-header"
      data-testid="sidebar-roles-header"
      className="relative mx-0.5 flex h-8 items-center"
    >
      <CollapsibleSectionHeader
        data-sidebar-row="shelf:roles"
        data-testid="sidebar-roles-shelf-toggle"
        onClick={section.toggle}
        expanded={section.expanded}
        accessory={
          <span className="inline-flex items-center gap-1.5 font-normal tabular-nums">
            {section.working ? <Spinner size="xs" /> : null}
            {section.needsYouCount}
          </span>
        }
      >
        {gt("Roles", { $context: "sidebar section" })}
      </CollapsibleSectionHeader>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={showAllLabel}
              aria-pressed={section.showAll}
              onClick={section.toggleShowAll}
              className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            />
          }
        >
          {section.showAll ? <EyeOffIcon className="size-3" /> : <EyeIcon className="size-3" />}
        </TooltipTrigger>
        <TooltipPopup side="top">{showAllLabel}</TooltipPopup>
      </Tooltip>
    </SortableSidebarMarker>
  );
}

// All lucide icons load as one chunk, only once a role names an icon.
const LucideRoleIcon = lazy(() =>
  import("../lib/lucideIconByName").then(({ lucideIconByName }) => ({
    default: function LucideRoleIcon(props: { name: string; className: string }) {
      return createElement(lucideIconByName(props.name) ?? BotIcon, { className: props.className });
    },
  })),
);

export function ForkRoleIcon(props: {
  readonly role: Pick<ForkRole, "icon" | "color"> | null;
  readonly className?: string;
}) {
  const className = cn("size-3.5 shrink-0", props.className);
  const icon = props.role?.icon;
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0", props.role?.color === undefined && "text-icon-muted")}
      style={props.role?.color === undefined ? undefined : { color: props.role.color }}
    >
      {icon === undefined ? (
        <BotIcon className={className} />
      ) : (
        <Suspense fallback={<BotIcon className={className} />}>
          <LucideRoleIcon name={icon} className={className} />
        </Suspense>
      )}
    </span>
  );
}

export function SidebarRoleIcon(props: {
  readonly environmentId: EnvironmentId;
  readonly roleId: string | null;
}) {
  return <ForkRoleIcon role={useForkRole(props.environmentId, props.roleId)} />;
}
