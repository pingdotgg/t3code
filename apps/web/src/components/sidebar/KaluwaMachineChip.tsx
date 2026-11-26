// Fork: the chip on a Kaluwa project folder saying which machine the project lives on, with a
// hover card for its system and connection. Hidden while this is the only machine.
import { useAtomValue } from "@effect/atom-react";
import { connectionCatalogDisplayUrl } from "@t3tools/client-runtime/connection";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";

import { useClientSettings } from "../../hooks/useSettings";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { ENVIRONMENT_MACHINE_KIND_LABELS, EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type KaluwaConnectionKind,
  type KaluwaMachineChipModel,
  type KaluwaMachineFacts,
  type KaluwaMachineState,
  resolveKaluwaMachineChip,
  resolveKaluwaMachineState,
} from "./kaluwaSidebarTree.logic";

function useKaluwaMachineFacts(): ReadonlyMap<EnvironmentId, KaluwaMachineFacts> {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const facts = new Map<EnvironmentId, KaluwaMachineFacts>();
  for (const [environmentId, presentation] of presentations) {
    const config = presentation.serverConfig;
    facts.set(environmentId, {
      environmentId,
      label: presentation.entry.target.label,
      machineKind: resolveEnvironmentMachineKind(config),
      os: config?.environment.platform.os ?? null,
      arch: config?.environment.platform.arch ?? null,
      hostname: config?.hostname ?? null,
      targetTag: presentation.entry.target._tag,
      displayUrl: connectionCatalogDisplayUrl(presentation.entry),
      phase: presentation.connection.phase,
    });
  }
  return facts;
}

function ConnectionLabel(props: { readonly kind: KaluwaConnectionKind }) {
  switch (props.kind) {
    case "local":
      return <T>This device</T>;
    case "tailscale":
      return <T>Tailscale</T>;
    case "lan":
      return <T>Local network</T>;
    case "relay":
      return <T>T3 Connect relay</T>;
    case "ssh":
      return <T>SSH</T>;
    case "direct":
      return <T>Direct</T>;
  }
}

function StateLabel(props: { readonly state: KaluwaMachineState }) {
  switch (props.state) {
    case "online":
      return <T context="machine connection state">Online</T>;
    case "connecting":
      return <T context="machine connection state">Connecting</T>;
    case "offline":
      return <T context="machine connection state">Offline</T>;
  }
}

const OS_NAMES = { darwin: "macOS", linux: "Linux", windows: "Windows" } as const;

function MachineHoverCard(props: { readonly chip: KaluwaMachineChipModel }) {
  const m = useMessages();
  const { chip } = props;
  const osName = chip.os === null || chip.os === "unknown" ? null : OS_NAMES[chip.os];
  return (
    <div className="kaluwa-machine-card">
      <div className="kaluwa-machine-card-title">
        <EnvironmentMachineIcon aria-hidden kind={chip.machineKind} className="size-3.5" />
        <span className="truncate">{chip.label}</span>
        {chip.isPrimary ? (
          <span className="kaluwa-machine-card-tag">
            <T>this machine</T>
          </span>
        ) : null}
      </div>
      <dl className="kaluwa-machine-card-grid">
        <dt>
          <T>System</T>
        </dt>
        <dd>
          {[osName, chip.arch, m(ENVIRONMENT_MACHINE_KIND_LABELS[chip.machineKind])]
            .filter(Boolean)
            .join(" · ")}
        </dd>
        <dt>
          <T>Connection</T>
        </dt>
        <dd>
          <ConnectionLabel kind={chip.connection} />
        </dd>
        <dt>
          <T>Status</T>
        </dt>
        <dd data-kaluwa-machine-state={chip.state}>
          <StateLabel state={chip.state} />
        </dd>
        {chip.hostname !== null && chip.hostname !== chip.label ? (
          <>
            <dt>
              <T>Host</T>
            </dt>
            <dd className="truncate">{chip.hostname}</dd>
          </>
        ) : null}
      </dl>
      {chip.others.length > 0 ? (
        <p className="kaluwa-machine-card-also">
          <T>
            Also on <Var>{chip.others.map((other) => other.label).join(", ")}</Var>
          </T>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Sits after the folder name. While the folder is open nothing holds the count's slot, so a
 * spacer keeps the hover's new-thread button off the chip.
 */
export function KaluwaMachineChip(props: {
  readonly group: Pick<SidebarProjectSnapshot, "memberProjects">;
  readonly collapsed: boolean;
}) {
  const gt = useGT();
  const indicator = useClientSettings((settings) => settings.kaluwaSidebarMachineIndicator);
  const machines = useKaluwaMachineFacts();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (indicator === "off") return null;
  const chip = resolveKaluwaMachineChip({
    environmentIds: props.group.memberProjects.map((member) => member.environmentId),
    machines,
    primaryEnvironmentId,
  });
  if (chip === null) return null;
  const name = chip.isPrimary
    ? chip.os === "darwin"
      ? gt("This Mac", { $context: "the machine this app runs on" })
      : gt("This machine")
    : chip.label;
  const spokenName = chip.others.length > 0 ? `${name} +${chip.others.length}` : name;
  if (indicator === "edge") {
    return (
      <span className="kaluwa-machine-edge" data-kaluwa-machine-color={chip.colorIndex}>
        <span className="sr-only">{gt("on {machine}", { machine: spokenName })}</span>
      </span>
    );
  }
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="kaluwa-machine-chip"
              data-kaluwa-machine-state={chip.state}
              aria-label={gt("On {machine}", { machine: spokenName })}
            />
          }
        >
          <EnvironmentMachineIcon
            aria-hidden
            kind={chip.machineKind}
            className="kaluwa-machine-chip-icon"
          />
          {indicator === "glyph-name" ? (
            <span className="kaluwa-machine-chip-name">{name}</span>
          ) : null}
          {chip.others.length > 0 ? (
            <span className="tabular-nums">+{chip.others.length}</span>
          ) : null}
          <span aria-hidden className="kaluwa-machine-chip-dot" />
        </TooltipTrigger>
        <TooltipPopup side="right" align="start">
          <MachineHoverCard chip={chip} />
        </TooltipPopup>
      </Tooltip>
      {props.collapsed ? null : <span aria-hidden className="kaluwa-machine-chip-spacer" />}
    </>
  );
}

/** The composer's machine label ends with the same online dot as the folder chip. */
export function KaluwaMachineStateDot(props: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const presentation = useAtomValue(environmentPresentations.presentationAtom(props.environmentId));
  if (presentation === null) return null;
  const state = resolveKaluwaMachineState(presentation.connection.phase);
  return (
    <span className="kaluwa-machine-state" data-kaluwa-machine-state={state}>
      <span aria-hidden className="kaluwa-machine-chip-dot" />
      <span className="sr-only">
        {state === "online"
          ? gt("Online", { $context: "machine connection state" })
          : state === "connecting"
            ? gt("Connecting", { $context: "machine connection state" })
            : gt("Offline", { $context: "machine connection state" })}
      </span>
    </span>
  );
}
