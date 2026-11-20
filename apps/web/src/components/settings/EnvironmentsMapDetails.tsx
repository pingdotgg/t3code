import { useAtomValue } from "@effect/atom-react";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import type { PeerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import {
  AuthMcpClientAccess,
  type EnvironmentId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { T, useGT, useMessages } from "gt-react";
import { ArrowRightIcon, ClockAlertIcon, PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { type ReactNode, useRef } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { cn } from "~/lib/utils";
import type { EnvironmentPresentation } from "~/state/environments";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { useAtomCommand } from "~/state/use-atom-command";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { Button } from "../ui/button";
import { formatAccessTimestamp } from "./ConnectionsSettings.logic";
import { EnvironmentRow, EnvironmentTransportLabel } from "./EnvironmentRow";
import {
  type FleetEnvironmentNode,
  type FleetFocus,
  type FleetGraph,
  type FleetLinkEdge,
  type FleetNode,
  type FleetStack,
  fleetSummary,
  isLinkEdge,
  linkNeedsAttention,
} from "./environmentsMap.logic";
import { peerLinkStatusText, useForgetPeerLink } from "./LinkedEnvironmentsSettings";
import { savedBackendStatus } from "./SavedEnvironmentRows";

type GT = ReturnType<typeof useGT>;

const ACCESS_LEVELS = AuthMcpClientAccess.literals;
export const accessLevel = (access: AuthMcpClientAccess) => ACCESS_LEVELS.indexOf(access);

/** Colour says how a link is doing; a healthy one stays neutral so trouble stands out. */
export function healthTone(health: PeerLinkHealth): string {
  if (health.kind === "expired" || health.kind === "failing") return "text-destructive";
  if (health.kind === "unreachable") return "text-muted-foreground";
  return health.expiresInDays === null ? "text-foreground/70" : "text-warning";
}

export function healthLabel(health: PeerLinkHealth, gt: GT): string {
  switch (health.kind) {
    case "expired":
      return gt("Expired", { $context: "status of a link between two machines" });
    case "unreachable":
      return gt("Not answering");
    case "failing":
      return gt("Failing", { $context: "status of a link between two machines" });
    case "reachable":
      return health.expiresInDays === null
        ? gt("Reachable")
        : gt("{days, plural, one {Expires in {days} day} other {Expires in {days} days}}", {
            days: health.expiresInDays,
          });
  }
}

/** Five rising bars, filled up to the access a link grants: read only is one, full access five. */
export function AccessMeter({
  access,
  className,
}: {
  access: AuthMcpClientAccess;
  className?: string;
}) {
  const level = accessLevel(access);
  return (
    <svg aria-hidden viewBox="0 0 19 12" className={cn("h-3 w-[19px] shrink-0", className)}>
      {ACCESS_LEVELS.map((step, index) => (
        <rect
          key={step}
          x={index * 4}
          y={8 - index * 2}
          width="3"
          height={4 + index * 2}
          rx="0.75"
          fill="currentColor"
          opacity={index <= level ? 1 : 0.22}
        />
      ))}
    </svg>
  );
}

export function HealthGlyph({ health }: { health: PeerLinkHealth }) {
  const tone = healthTone(health);
  if (health.kind === "expired") return <XIcon aria-hidden className={cn("size-3", tone)} />;
  if (health.kind === "failing") {
    return <TriangleAlertIcon aria-hidden className={cn("size-3", tone)} />;
  }
  if (health.kind === "unreachable") {
    return <span aria-hidden className="size-2 rounded-full border border-muted-foreground" />;
  }
  return health.expiresInDays === null ? (
    <span aria-hidden className="size-2 rounded-full bg-success forced-colors:border-4" />
  ) : (
    <ClockAlertIcon aria-hidden className={cn("size-3", tone)} />
  );
}

export interface FleetDetailsProps {
  readonly graph: FleetGraph;
  readonly stacks: ReadonlyArray<FleetStack>;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  /** Why the account's T3 Connect machines are missing from the map, and how to ask again. */
  readonly connectProblem: { readonly message: string; readonly retry: () => void } | null;
  readonly selection: FleetFocus | null;
  readonly onSelect: (focus: FleetFocus | null) => void;
  /** Opens the link flow from an environment, with no target picked yet. */
  readonly onLinkFrom: (sourceId: string) => void;
  readonly onToggleStack: (stackId: string) => void;
  /** The list's own row for a saved environment, or null where the list has none. */
  readonly renderSavedEnvironment: (environment: EnvironmentPresentation) => ReactNode;
  readonly renderConnectMachine: (environmentId: EnvironmentId) => ReactNode;
  readonly onAddEnvironment: (host?: string) => void;
}

const SECTION = "px-3 py-3 sm:px-4";

/** What is selected on the map, with the controls the list keeps on each row. */
export function FleetDetails(props: FleetDetailsProps) {
  const { graph, stacks, selection, onSelect, connectProblem } = props;
  const gt = useGT();
  const panel = useRef<HTMLDivElement>(null);
  const links = graph.edges.filter(isLinkEdge);
  const node =
    selection?.kind === "node" ? graph.nodes.find((entry) => entry.id === selection.id) : undefined;
  const edge =
    selection?.kind === "edge" ? links.find((entry) => entry.id === selection.id) : undefined;
  const stack =
    selection?.kind === "stack" ? stacks.find((entry) => entry.id === selection.id) : undefined;
  const labelOf = (id: string) => graph.nodes.find((entry) => entry.id === id)?.label ?? "";
  // Choosing inside the panel replaces the control that was pressed, so focus stays on the panel.
  const selectWithin = (focus: FleetFocus) => {
    onSelect(focus);
    panel.current?.focus();
  };
  return (
    <div
      ref={panel}
      tabIndex={-1}
      role="group"
      aria-label={gt("Details")}
      className="min-h-20 border-t border-border/60 text-xs outline-none"
    >
      {connectProblem ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/60 px-3 py-2 sm:px-4">
          <p className="min-w-0 flex-1 text-muted-foreground">
            <span className="font-medium text-destructive">
              <T>Could not load T3 Connect environments</T>
            </span>{" "}
            {connectProblem.message}
          </p>
          <Button size="xs" variant="outline" onClick={connectProblem.retry}>
            {gt("Try again")}
          </Button>
        </div>
      ) : null}
      {edge ? (
        <div className={SECTION}>
          <LinkDetails
            key={edge.id}
            edge={edge}
            sourceLabel={labelOf(edge.from)}
            targetLabel={labelOf(edge.to)}
            onSelect={selectWithin}
          />
        </div>
      ) : stack ? (
        <StackDetails
          stack={stack}
          links={links}
          labelOf={labelOf}
          onSelect={selectWithin}
          onToggle={() => props.onToggleStack(stack.id)}
        />
      ) : node ? (
        <NodeDetails {...props} key={node.id} node={node} links={links} onSelect={selectWithin} />
      ) : (
        <FleetSummary graph={graph} links={links} />
      )}
    </div>
  );
}

function Heading({ children, detail }: { children: ReactNode; detail?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <h3 className="text-sm font-medium text-foreground">{children}</h3>
      {detail ? <span className="text-muted-foreground">{detail}</span> : null}
    </div>
  );
}

function FleetSummary({
  graph,
  links,
}: {
  readonly graph: FleetGraph;
  readonly links: ReadonlyArray<FleetLinkEdge>;
}) {
  const gt = useGT();
  const summary = fleetSummary(graph);
  const attention = links.filter((edge) => linkNeedsAttention(edge.health)).length;
  const { machines } = summary;
  const canLink = graph.nodes.some(
    (entry) => entry.kind === "environment" && entry.linking === "ready",
  );
  return (
    <div className={SECTION}>
      <Heading
        detail={
          summary.loading
            ? gt("Loading links…")
            : attention > 0
              ? gt(
                  "{count, plural, one {# link needs attention.} other {# links need attention.}}",
                  { count: attention },
                )
              : null
        }
      >
        {summary.links !== null
          ? gt(
              "{machines, plural, one {# machine} other {# machines}}, {links, plural, =0 {no links} one {# link} other {# links}}",
              { machines, links: summary.links },
            )
          : gt("{machines, plural, one {# machine} other {# machines}}", { machines })}
      </Heading>
      <p className="max-w-2xl text-muted-foreground">
        {canLink
          ? gt(
              "Select a machine to manage it. To link two machines, drag the plus on an environment onto another machine, or press it to pick one.",
            )
          : gt("Select a machine to manage it.")}{" "}
        {gt(
          "A link reaches one machine and stops there. It does not pass on to the machines that one links to.",
        )}
      </p>
    </div>
  );
}

/** One link as a row: what it reaches, the access in words, where, and how it is doing. */
function LinkButton({
  edge,
  label,
  onSelect,
}: {
  readonly edge: FleetLinkEdge;
  readonly label: string;
  readonly onSelect: (focus: FleetFocus) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const attention = linkNeedsAttention(edge.health);
  return (
    <li>
      <button
        type="button"
        className="grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-1.5 py-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset lg:grid-cols-[auto_minmax(0,10rem)_minmax(0,10rem)_minmax(0,1fr)_auto]"
        onClick={() => onSelect({ kind: "edge", id: edge.id })}
      >
        <AccessMeter access={edge.link.access} className="text-foreground/80" />
        <span className="truncate font-medium text-foreground">{label}</span>
        <span className="truncate text-foreground/80">
          {m(accessConfig[edge.link.access].label)}
        </span>
        <span className="hidden truncate font-mono text-2xs text-muted-foreground lg:block">
          {edge.link.urls[0]}
        </span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5",
            attention ? healthTone(edge.health) : "text-muted-foreground",
          )}
        >
          <HealthGlyph health={edge.health} />
          {attention
            ? healthLabel(edge.health, gt)
            : gt("Expires {date}", {
                date: formatAccessTimestamp(DateTime.formatIso(edge.link.expiresAt)),
                $context: "the date a link between two machines stops working",
              })}
        </span>
      </button>
    </li>
  );
}

function StackDetails({
  stack,
  links,
  labelOf,
  onSelect,
  onToggle,
}: {
  readonly stack: FleetStack;
  readonly links: ReadonlyArray<FleetLinkEdge>;
  readonly labelOf: (id: string) => string;
  readonly onSelect: (focus: FleetFocus) => void;
  readonly onToggle: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const members = stack.edgeIds.flatMap((id) => links.find((edge) => edge.id === id) ?? []);
  return (
    <div className={SECTION}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Heading
          detail={gt(
            "{count, plural, one {# machine} other {# machines}} linked from {source}, {access}, {reachable} reachable",
            {
              count: members.length,
              source: labelOf(stack.sourceId),
              access: m(accessConfig[stack.access].label),
              reachable: stack.reachable,
            },
          )}
        >
          {stack.firstLabel} … {stack.lastLabel}
        </Heading>
        <Button size="xs" variant="outline" onClick={onToggle}>
          {stack.expanded ? gt("Collapse on the map") : gt("Show each on the map")}
        </Button>
      </div>
      <ul className="-mx-1.5 max-h-64 overflow-y-auto">
        {members.map((edge) => (
          <LinkButton key={edge.id} edge={edge} label={labelOf(edge.to)} onSelect={onSelect} />
        ))}
      </ul>
    </div>
  );
}

function LinkAnother({
  node,
  onLinkFrom,
}: {
  readonly node: FleetEnvironmentNode;
  readonly onLinkFrom: (sourceId: string) => void;
}) {
  const gt = useGT();
  // The command's own permission, which follows the session as the node's snapshot cannot.
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(node.environmentId));
  if (!canLink || node.linking !== "ready") return null;
  return (
    <Button size="xs" onClick={() => onLinkFrom(node.id)}>
      <PlusIcon className="size-3" />
      {gt("Link", { $context: "verb, links an environment" })}
    </Button>
  );
}

function Reconnect({ environment }: { readonly environment: EnvironmentPresentation }) {
  const gt = useGT();
  const m = useMessages();
  const retryNow = useAtomCommand(environmentCatalog.retryNow);
  const { phase } = environment.connection;
  if (!environment.entry.enabled || phase === "connected" || phase === "unsupported") return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground">{savedBackendStatus(environment, m).text}</span>
      <Button
        size="xs"
        variant="outline"
        disabled={phase === "connecting"}
        onClick={() => void retryNow(environment.environmentId)}
      >
        {gt("Reconnect")}
      </Button>
    </div>
  );
}

function linksNote(node: FleetEnvironmentNode, gt: GT): string | null {
  if (node.phase !== "connected") {
    return gt(
      "This app is not connected to {label} right now, so any links it holds to other machines are not shown.",
      { label: node.label },
    );
  }
  switch (node.outgoing) {
    case "off":
      return gt(
        "Linked environments is off on {label}. Turn it on in its Settings, under Labs, to link from it.",
        { label: node.label },
      );
    case "unknown":
      return gt("This app may not read the links {label} holds.", { label: node.label });
    case "error":
      return gt("Could not load the links {label} holds: {error}", {
        label: node.label,
        error: node.outgoingError ?? "",
      });
    case "loading":
      return gt("Loading linked environments…");
    case "loaded":
      return null;
  }
}

function LinkList({
  title,
  action,
  edges,
  labelOf,
  onSelect,
}: {
  readonly title: string | null;
  readonly action?: ReactNode;
  readonly edges: ReadonlyArray<FleetLinkEdge>;
  readonly labelOf: (edge: FleetLinkEdge) => string;
  readonly onSelect: (focus: FleetFocus) => void;
}) {
  return (
    <section>
      <div className="mb-1 flex min-h-6 items-center gap-3">
        {title === null ? null : <h4 className="font-medium text-foreground">{title}</h4>}
        {action}
      </div>
      {edges.length > 0 ? (
        <ul className="-mx-1.5 max-h-48 overflow-y-auto">
          {edges.map((edge) => (
            <LinkButton key={edge.id} edge={edge} label={labelOf(edge)} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function NodeDetails({
  node,
  graph,
  links,
  environments,
  onSelect,
  onLinkFrom,
  renderSavedEnvironment,
  renderConnectMachine,
  onAddEnvironment,
}: Omit<FleetDetailsProps, "selection" | "stacks" | "onToggleStack" | "onSelect"> & {
  readonly node: FleetNode;
  readonly links: ReadonlyArray<FleetLinkEdge>;
  readonly onSelect: (focus: FleetFocus) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const labelOf = (id: string) => graph.nodes.find((entry) => entry.id === id)?.label ?? "";
  if (node.kind === "client") {
    const hosts = graph.nodes.filter((entry) => entry.kind === "environment");
    return (
      <div className={SECTION}>
        <Heading
          detail={gt("Connected to {connected} of {total} environments", {
            connected: hosts.filter((entry) => entry.phase === "connected").length,
            total: hosts.length,
          })}
        >
          {node.label}
        </Heading>
        <p className="max-w-2xl text-muted-foreground">
          {gt(
            "Each line from here is a saved route to an environment. The map shows the links of the environments this app is connected to; one it cannot reach may hold links that are not drawn.",
          )}
        </p>
      </div>
    );
  }
  const out = links.filter((edge) => edge.from === node.id);
  const incoming = links.filter((edge) => edge.to === node.id);
  const linkedFrom = (
    <LinkList
      title={gt(
        "{count, plural, =0 {No known machine links here} one {Linked from # machine} other {Linked from # machines}}",
        { count: incoming.length },
      )}
      edges={incoming}
      labelOf={(edge) => labelOf(edge.from)}
      onSelect={onSelect}
    />
  );
  if (node.kind === "connect") {
    return (
      <>
        {renderConnectMachine(node.environmentId)}
        <div className={cn(SECTION, "space-y-3 border-t border-border/60")}>
          <p className="max-w-2xl text-muted-foreground">
            {gt(
              "{label} is on your T3 Connect account but not added to this app. Add it to connect, and to see the links it holds.",
              { label: node.label },
            )}
          </p>
          {incoming.length > 0 ? linkedFrom : null}
        </div>
      </>
    );
  }
  if (node.kind === "target") {
    return (
      <div className={SECTION}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <Heading detail={gt("Known only through a link")}>{node.label}</Heading>
          <Button
            size="xs"
            variant="outline"
            onClick={() => onAddEnvironment(node.address ?? undefined)}
          >
            <PlusIcon className="size-3" />
            {gt("Add environment")}
          </Button>
        </div>
        {/* A machine known only through its links is its links, so each one is shown in full. */}
        <div className="space-y-4">
          {incoming.map((edge) => (
            <LinkDetails
              key={edge.id}
              edge={edge}
              sourceLabel={labelOf(edge.from)}
              targetLabel={node.label}
              onSelect={onSelect}
            />
          ))}
        </div>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          {gt(
            "This app is not connected to {label}, so any links it holds to other machines are not shown.",
            { label: node.label },
          )}
        </p>
      </div>
    );
  }
  const environment = environments.find((entry) => entry.environmentId === node.environmentId);
  const saved = environment ? renderSavedEnvironment(environment) : null;
  const note = linksNote(node, gt);
  const loaded = node.outgoing === "loaded";
  return (
    <>
      {saved ??
        (environment ? (
          <EnvironmentRow
            kind={resolveEnvironmentMachineKind(environment.serverConfig)}
            label={environment.label}
            subtitle={
              <>
                <EnvironmentTransportLabel environment={environment} />
                {" · "}
                {connectionStatusTitle(environment.connection, m)}
                {environment.serverConfig
                  ? ` · ${environment.serverConfig.environment.serverVersion}`
                  : ""}
              </>
            }
          />
        ) : null)}
      <div className={cn(SECTION, "space-y-3 border-t border-border/60")}>
        {environment && saved !== null ? <Reconnect environment={environment} /> : null}
        {note ? <p className="max-w-2xl text-muted-foreground">{note}</p> : null}
        <LinkList
          title={
            loaded
              ? gt(
                  "{count, plural, =0 {Links to no one} one {Links to # machine} other {Links to # machines}}",
                  { count: out.length },
                )
              : null
          }
          action={<LinkAnother node={node} onLinkFrom={onLinkFrom} />}
          edges={out}
          labelOf={(edge) => labelOf(edge.to)}
          onSelect={onSelect}
        />
        {linkedFrom}
      </div>
    </>
  );
}

function LinkDetails({
  edge,
  sourceLabel,
  targetLabel,
  onSelect,
}: {
  readonly edge: FleetLinkEdge;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly onSelect: (focus: FleetFocus) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { link, health } = edge;
  const canUnlink = useAtomValue(
    peerLinkEnvironment.unlink.permissionAtom(edge.sourceEnvironmentId),
  );
  const { busy, forget } = useForgetPeerLink(edge.sourceEnvironmentId, link);
  const access = accessConfig[link.access];
  const when = (value: DateTime.Utc) => formatAccessTimestamp(DateTime.formatIso(value));
  const term = "text-muted-foreground";
  const endpoint =
    "cursor-pointer rounded-sm font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
          <button
            type="button"
            className={endpoint}
            onClick={() => onSelect({ kind: "node", id: edge.from })}
          >
            {sourceLabel}
          </button>
          <ArrowRightIcon
            role="img"
            aria-label={gt("links to", { $context: "between two machine names: A links to B" })}
            className="size-3.5 text-muted-foreground"
          />
          <button
            type="button"
            className={endpoint}
            onClick={() => onSelect({ kind: "node", id: edge.to })}
          >
            {targetLabel}
          </button>
        </h3>
        {canUnlink ? (
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={busy}
            onClick={() => void forget()}
          >
            {busy ? gt("Forgetting…") : gt("Forget")}
          </Button>
        ) : null}
      </div>
      <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <dt className={term}>{gt("Access", { $context: "access level" })}</dt>
        <dd>
          <span className="flex items-center gap-2 font-medium text-foreground">
            <AccessMeter access={link.access} className="text-foreground/80" />
            {m(access.label)}
          </span>
          <span className="text-muted-foreground">{m(access.description)}</span>
        </dd>
        <dt className={term}>
          {gt("Status", { $context: "state of a link between two machines" })}
        </dt>
        <dd
          className={cn(
            "flex items-center gap-1.5",
            linkNeedsAttention(health) ? healthTone(health) : "text-foreground",
          )}
        >
          <HealthGlyph health={health} />
          {peerLinkStatusText(health, gt)}
        </dd>
        <dt className={term}>
          {gt("Expires", { $context: "label before the date a link expires" })}
        </dt>
        <dd className="text-foreground">{when(link.expiresAt)}</dd>
        <dt className={term}>{gt("Addresses")}</dt>
        <dd className="min-w-0 font-mono text-2xs break-all text-foreground">
          {link.urls.map((url) => (
            <span key={url} className="block">
              {url}
            </span>
          ))}
        </dd>
        <dt className={term}>
          {gt("Linked", { $context: "label before the date a link was made" })}
        </dt>
        <dd className="text-foreground">{when(link.linkedAt)}</dd>
        {link.lastReachedAt ? (
          <>
            <dt className={term}>{gt("Last reached")}</dt>
            <dd className="text-foreground">{when(link.lastReachedAt)}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
