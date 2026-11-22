import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDownIcon, MonitorSmartphoneIcon } from "lucide-react";

import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import type { SidebarEnvironmentWork } from "../Sidebar.logic";
import {
  Menu,
  MenuGroupLabel,
  MenuItemDetail,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { cn } from "../../lib/utils";
import { useEnvironment, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentTransportLabel } from "../settings/EnvironmentRow";
import { SidebarMenuButton, useSidebar } from "../ui/sidebar";

const ALL_ENVIRONMENTS = "all";

/**
 * The footer's environment chip: the environment in view, its connection and route. With several
 * environments it narrows the sidebar to one. It only hides rows: connections stay as they are, and
 * the trigger keeps a dot while a hidden environment has a thread waiting on the user.
 */
export function SidebarEnvironmentScopeMenu({
  environments,
  machineByEnvironmentId,
  value,
  work,
  onValueChange,
}: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
  readonly value: EnvironmentId | null;
  readonly work: ReadonlyMap<EnvironmentId, SidebarEnvironmentWork>;
  readonly onValueChange: (environmentId: EnvironmentId | null) => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const selected = environments.find((environment) => environment.environmentId === value);
  const hiddenNeedsYou =
    value === null
      ? 0
      : [...work].reduce(
          (total, [environmentId, entry]) =>
            environmentId === value ? total : total + entry.needsYou,
          0,
        );
  const label = selected
    ? hiddenNeedsYou > 0
      ? gt(
          "{count, plural, one {Showing {environment}. {count} thread elsewhere needs you} other {Showing {environment}. {count} threads elsewhere need you}}",
          { environment: selected.label, count: hiddenNeedsYou },
        )
      : gt("Showing {environment}", { environment: selected.label })
    : gt("Filter threads by environment");
  const detail = (entry: SidebarEnvironmentWork | undefined) => {
    if (entry === undefined) return null;
    const parts = [
      entry.needsYou > 0
        ? gt("{count, plural, one {{count} needs you} other {{count} need you}}", {
            count: entry.needsYou,
          })
        : null,
      entry.working > 0 ? gt("{count} working", { count: entry.working }) : null,
    ].filter((part) => part !== null);
    return parts.length === 0 ? null : <MenuItemDetail>{parts.join(" · ")}</MenuItemDetail>;
  };

  const shown = selected ?? (environments.length === 1 ? environments[0] : undefined);
  const chip = (
    <>
      {shown ? (
        <EnvironmentChipStatus
          environmentId={shown.environmentId}
          label={shown.label}
          kind={machineByEnvironmentId.get(shown.environmentId) ?? "desktop"}
        />
      ) : (
        <>
          <MonitorSmartphoneIcon aria-hidden />
          <span className="min-w-0 flex-1 truncate">{gt("All environments")}</span>
        </>
      )}
      {hiddenNeedsYou > 0 ? (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
      ) : null}
    </>
  );

  if (environments.length === 0) return null;
  // One environment has nothing to filter; the chip leads to its connection instead.
  if (environments.length === 1) {
    return (
      <SidebarMenuButton
        aria-label={gt("Connection settings for {environment}", {
          environment: environments[0]!.label,
        })}
        onClick={() => {
          if (isMobile) setOpenMobile(false);
          void navigate({ to: "/settings/connections" });
        }}
      >
        {chip}
      </SidebarMenuButton>
    );
  }

  return (
    <Menu>
      <MenuTrigger render={<SidebarMenuButton aria-label={label} />}>
        {chip}
        <ChevronsUpDownIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="start" className="w-[min(18rem,var(--available-width))]">
        <MenuRadioGroup
          value={value ?? ALL_ENVIRONMENTS}
          onValueChange={(next: string) =>
            onValueChange(next === ALL_ENVIRONMENTS ? null : (next as EnvironmentId))
          }
        >
          <MenuGroupLabel>{gt("Show threads from")}</MenuGroupLabel>
          <MenuRadioItem value={ALL_ENVIRONMENTS} closeOnClick>
            <span className="flex min-w-0 items-center gap-2">
              <MonitorSmartphoneIcon className="size-4" aria-hidden />
              <span className="min-w-0 truncate">{gt("All environments")}</span>
            </span>
          </MenuRadioItem>
          {environments.map((environment) => (
            <MenuRadioItem
              key={environment.environmentId}
              value={environment.environmentId}
              closeOnClick
            >
              <span className="flex min-w-0 items-center gap-2">
                <EnvironmentMachineIcon
                  kind={machineByEnvironmentId.get(environment.environmentId) ?? "desktop"}
                  className="size-4"
                  aria-hidden
                />
                <span className="min-w-0 truncate">{environment.label}</span>
                {detail(work.get(environment.environmentId))}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function connectionDotClassName(phase: EnvironmentConnectionPhase): string {
  switch (phase) {
    case "connected":
      return "bg-success";
    case "connecting":
    case "reconnecting":
      return "bg-warning";
    case "error":
    case "offline":
    case "unsupported":
      return "bg-error";
    case "available":
      return "bg-muted-foreground/40";
  }
}

function EnvironmentChipStatus({
  environmentId,
  label,
  kind,
}: {
  environmentId: EnvironmentId;
  label: string;
  kind: EnvironmentMachineKind;
}) {
  const environment = useEnvironment(environmentId);
  return (
    <>
      <span className="relative flex shrink-0">
        <EnvironmentMachineIcon kind={kind} className="size-4" aria-hidden />
        {environment ? (
          <span
            aria-hidden
            className={cn(
              "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-sidebar",
              connectionDotClassName(environment.connection.phase),
            )}
          />
        ) : null}
      </span>
      <span className="min-w-0 truncate text-sidebar-foreground">{label}</span>
      {environment ? <EnvironmentRouteLabel environment={environment} /> : null}
      <span className="flex-1" />
    </>
  );
}

function EnvironmentRouteLabel({ environment }: { environment: EnvironmentPresentation }) {
  const route = useEnvironmentTransportLabel(environment);
  return (
    <span className="min-w-0 shrink truncate text-xs font-normal text-sidebar-muted-foreground">
      {route}
    </span>
  );
}
