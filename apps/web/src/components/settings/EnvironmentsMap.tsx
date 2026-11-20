import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type ConnectionRouteKind,
  connectionRouteId,
  connectionRouteKind,
  connectionRoutes,
} from "@t3tools/client-runtime/connection";
import {
  ANOTHER_ADDRESS,
  linkableMachines,
  offersLinkedEnvironments,
} from "@t3tools/client-runtime/link-request";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { PeerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import { AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { useGT, useMessages } from "gt-react";
import {
  AppWindowIcon,
  CloudIcon,
  GlobeIcon,
  MaximizeIcon,
  MinusIcon,
  PlusIcon,
  UnfoldVerticalIcon,
  FoldVerticalIcon,
} from "lucide-react";
import {
  memo,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { isElectron } from "~/env";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { useNowMinute } from "~/hooks/useNowMinute";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import {
  type EnvironmentPresentation,
  useEnvironments,
  useRelayEnvironmentDiscovery,
  useRetainedRelayEnvironments,
} from "~/state/environments";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { peerLinkEnvironment, peerLinkListsAtom, usePeerLinkHosts } from "~/state/peerLinks";
import { formatEnvironmentQueryError } from "~/state/query";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { preparedConnectionsAtom, useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { connectionPhaseDotClassName } from "../ConnectionStatusDot";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import {
  buildFleetGraph,
  fitFleetLayout,
  fleetCanvasHeight,
  FLEET_CLIENT_NODE_ID,
  fleetEnvironmentNodeId,
  fleetFocusRects,
  fleetLinkOffer,
  fleetNeighborhood,
  fleetShapeKey,
  fleetStacks,
  type FleetColumn,
  type FleetDirection,
  type FleetEnvironmentInput,
  type FleetEnvironmentNode,
  type FleetFocus,
  type FleetGraph,
  type FleetLayout,
  type FleetLinkEdge,
  type FleetLinkOffer,
  type FleetNode,
  type FleetRect,
  type FleetRouteState,
  type FleetStack,
  type FleetViewTransform,
  isLinkEdge,
  isRouteEdge,
  layoutFleetGraph,
  zoomFleetView,
  nextFleetNode,
} from "./environmentsMap.logic";
import {
  AccessMeter,
  accessLevel,
  FleetDetails,
  type FleetDetailsProps,
  HealthGlyph,
  healthLabel,
  healthTone,
} from "./EnvironmentsMapDetails";
import { LinkEnvironmentDialog, type LinkEnvironmentPrefill } from "./LinkedEnvironmentsSettings";
import { savedBackendStatus } from "./SavedEnvironmentRows";
import { SettingsSearchTarget } from "./settingsLayout";

type GT = ReturnType<typeof useGT>;
type Messages = ReturnType<typeof useMessages>;

/** One ordinal scale for access, read only to full access: a link's line gets heavier and darker. */
const ACCESS_STROKE_WIDTHS = [1.25, 1.75, 2.25, 2.75, 3.5];
const ACCESS_STROKE_OPACITIES = [0.4, 0.5, 0.62, 0.76, 0.9];
const CANVAS_HEIGHT = { min: 260, max: 620 };
const ARROW_ROVE: Record<string, FleetDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};
const NO_STACKS: ReadonlySet<string> = new Set();

/** Dashes repeat a link's health without colour, one pattern per kind of trouble. */
function healthDash(health: PeerLinkHealth): string | undefined {
  if (health.kind === "expired") return "1 5";
  if (health.kind === "failing") return "8 3 1 3";
  return health.kind === "unreachable" ? "5 4" : undefined;
}

const troubleRank = (health: PeerLinkHealth) =>
  health.kind === "expired"
    ? 0
    : health.kind === "failing"
      ? 1
      : health.kind === "unreachable"
        ? 2
        : health.expiresInDays === null
          ? 4
          : 3;
/** Worst first: a machine several hosts link to wears the health of its most troubled link. */
const byTrouble = (left: FleetLinkEdge, right: FleetLinkEdge) =>
  troubleRank(left.health) - troubleRank(right.health);

/** A machine's outline carries its link's health too. */
function healthBorder(health: PeerLinkHealth): string {
  if (health.kind === "expired") return "border-dotted border-destructive/70";
  if (health.kind === "failing") return "border-destructive/70";
  if (health.kind === "unreachable") return "border-dashed border-foreground/35";
  return health.expiresInDays === null ? "border-border" : "border-warning/70";
}

/** How each route state is drawn: the one in use stands out, the rest stay quiet. */
const ROUTE_STYLES: Record<
  FleetRouteState,
  { readonly wire: string; readonly width: number; readonly dash?: string; readonly pill: string }
> = {
  "in-use": {
    wire: "text-success",
    width: 1.75,
    pill: "border-success/70 font-medium text-foreground",
  },
  standby: { wire: "text-muted-foreground/60", width: 1, pill: "border-border" },
  trying: { wire: "text-warning", width: 1, dash: "1 4", pill: "border-warning/60" },
  down: { wire: "text-muted-foreground/60", width: 1, dash: "4 4", pill: "border-dashed" },
  idle: { wire: "text-muted-foreground/40", width: 1, dash: "4 4", pill: "border-dashed" },
  refused: {
    wire: "text-destructive/80",
    width: 1,
    dash: "4 4",
    pill: "border-dashed border-destructive/60 text-destructive",
  },
  offered: { wire: "text-muted-foreground/50", width: 1, dash: "1 4", pill: "border-dotted" },
};

function routeKindLabel(kind: ConnectionRouteKind, gt: GT): string {
  switch (kind) {
    case "relay":
      return "T3 Connect";
    case "loopback":
      return gt("This device");
    case "lan":
      return "LAN";
    case "tailnet":
      return "Tailscale";
    case "vpn":
      return "VPN";
    case "ssh":
      return "SSH";
    case "public":
      return gt("Public", { $context: "kind of network route: a public internet address" });
  }
}

function routeStateLabel(state: FleetRouteState, gt: GT): string {
  switch (state) {
    case "in-use":
      return gt("In use");
    case "standby":
      return gt("Standby", { $context: "a network route that is saved but not carrying traffic" });
    case "trying":
      return gt("Connecting");
    case "down":
      return gt("Not connected");
    case "idle":
      return gt("Not in use");
    case "refused":
      return gt("Sign-in refused");
    case "offered":
      return gt("Not added");
  }
}

/** Asks T3 Connect for the account's machines once, as the list's own rows do on mount. */
function useConnectMachines() {
  const gt = useGT();
  const m = useMessages();
  const discovery = useRelayEnvironmentDiscovery();
  const refresh = useAtomCommand(relayEnvironmentDiscovery.refresh, { reportFailure: false });
  const discoverIfUnasked = useEffectEvent(() => {
    if (hasCloudPublicConfig() && !discovery.listed && !discovery.refreshing) void refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one T3 Connect listing when the map mounts, the request the list makes on mount
  useEffect(() => {
    discoverIfUnasked();
  }, []);
  const machines = useRetainedRelayEnvironments();
  // A failed listing is not an account with no machines: say so, with a way to ask again.
  const message = discovery.refreshing
    ? null
    : discovery.offline && !discovery.listed
      ? gt("You appear to be offline.")
      : thrownErrorMessage(Option.getOrNull(discovery.error), m);
  return {
    machines,
    problem: message === null ? null : { message, retry: () => void refresh() },
  };
}

function useFleetGraph() {
  const gt = useGT();
  const m = useMessages();
  const { environments } = useEnvironments();
  const hosts = usePeerLinkHosts();
  const nowMinute = useNowMinute();
  const hostsKey = environmentIdsKey(hosts.map((host) => host.environmentId));
  const lists = useAtomValue(peerLinkListsAtom(hostsKey));
  const registry = useContext(RegistryContext);
  // Links made from another client or the CLI bump nothing these lists read, so coming back to
  // the window asks again, as the list view does, and so does a change in which machines can be
  // asked. Listing probes every linked machine: too costly for a timer.
  useLiveRefresh(
    () => {
      for (const host of hosts) {
        const list = peerLinkEnvironment.list({ environmentId: host.environmentId, input: {} });
        if (!registry.get(list).waiting) registry.refresh(list);
      }
    },
    { key: `environments-map:${hostsKey}`, intervalMs: null, refreshOnShow: true },
  );
  const prepared = useAtomValue(
    preparedConnectionsAtom(
      environmentIdsKey(environments.map((environment) => environment.environmentId)),
    ),
  );
  const writable = useEnvironmentsWithScope(environments, AuthAccessWriteScope);
  const { machines: connect, problem: connectProblem } = useConnectMachines();
  const machines = linkableMachines({
    environments,
    threadEnvironmentId: null,
    links: [],
    connect,
  });
  const machineById = new Map(machines.map((machine) => [machine.environmentId, machine]));
  const listByHost = new Map(hosts.map((host, index) => [host.environmentId, lists[index]]));
  const inputs = environments.map((environment, index): FleetEnvironmentInput => {
    const list = listByHost.get(environment.environmentId);
    const connected = environment.connection.phase === "connected";
    const active = connected ? Option.getOrNull(prepared[index] ?? Option.none()) : null;
    const offersLinks = offersLinkedEnvironments(environment.serverConfig);
    return {
      environmentId: environment.environmentId,
      label: environment.label,
      machine: machineById.get(environment.environmentId)?.machine ?? null,
      phase: environment.connection.phase,
      enabled: environment.entry.enabled,
      routes: connectionRoutes(environment.entry).map((route) => ({
        id: connectionRouteId(route.target),
        kind: connectionRouteKind(route),
      })),
      activeRouteId: active === null ? null : connectionRouteId(active.target),
      refusedRouteIds: environment.refusedRouteIds,
      offersLinks,
      canWriteAccess: writable.has(environment.environmentId),
      hasLinkAddress: (machineById.get(environment.environmentId)?.urls.length ?? 0) > 0,
      outgoing:
        list === undefined
          ? { state: connected && !offersLinks ? "off" : "unknown" }
          : list._tag === "Success"
            ? { state: "loaded", links: list.value.links }
            : list._tag === "Failure"
              ? { state: "error", message: formatEnvironmentQueryError(list.cause, m) }
              : { state: "loading" },
    };
  });
  const graph = buildFleetGraph({
    clientLabel: isElectron ? gt("This device") : gt("This browser"),
    environments: inputs,
    connectMachines: machines
      .filter((machine) => machine.connectOnly)
      .map((machine) => ({
        environmentId: machine.environmentId,
        label: machine.label,
        machine: machine.machine,
        availability: connect.get(machine.environmentId)?.availability ?? "checking",
      })),
    now: DateTime.makeUnsafe(nowMinute),
  });
  return { graph, environments, connectProblem };
}

/** The layout for the graph's current shape; a health or status change reuses the last one. */
function useFleetLayout(graph: FleetGraph, stacks: ReadonlyArray<FleetStack>) {
  const key = fleetShapeKey(graph, stacks);
  const [laid, setLaid] = useState(() => ({ key, layout: layoutFleetGraph(graph, stacks) }));
  if (laid.key === key) return laid;
  const next = { key, layout: layoutFleetGraph(graph, stacks) };
  setLaid(next);
  return next;
}

interface LinkRequest {
  readonly serial: number;
  readonly environmentId: EnvironmentId;
  readonly prefill: LinkEnvironmentPrefill;
  readonly open: boolean;
}

/**
 * Every machine this app knows about, how it reaches each one, and which of them are linked.
 * Selecting a machine shows the controls the list has for it.
 */
export function EnvironmentsMap(
  props: Pick<
    FleetDetailsProps,
    "renderSavedEnvironment" | "renderConnectMachine" | "onAddEnvironment"
  > & { readonly footerId?: string },
) {
  const { graph, environments, connectProblem } = useFleetGraph();
  const [expanded, setExpanded] = useState(NO_STACKS);
  const stacks = fleetStacks(graph, expanded);
  const { key, layout } = useFleetLayout(graph, stacks);
  const [picked, setPicked] = useState<FleetFocus | null>(null);
  const [linkRequest, setLinkRequest] = useState<LinkRequest | null>(null);
  const selection =
    picked === null
      ? null
      : (picked.kind === "stack"
            ? stacks
            : picked.kind === "node"
              ? graph.nodes
              : graph.edges
          ).some((item) => item.id === picked.id)
        ? picked
        : null;
  const toggleStack = (stackId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(stackId)) next.add(stackId);
      return next;
    });
  // One dialog for every way in: a drop names the target, the handle and the details do not.
  const requestLink = (sourceId: string, targetId: string | null) => {
    const source = graph.nodes.find((node) => node.id === sourceId);
    if (source?.kind !== "environment" || source.linking !== "ready") return;
    const offer = targetId === null ? null : fleetLinkOffer(graph, sourceId, targetId);
    if (offer !== null && offer.kind !== "link") return;
    setLinkRequest((current) => ({
      serial: (current?.serial ?? 0) + 1,
      environmentId: source.environmentId,
      open: true,
      prefill:
        offer === null
          ? { choice: null }
          : offer.target.kind === "machine"
            ? { choice: offer.target.environmentId }
            : { choice: ANOTHER_ADDRESS, address: offer.target.address ?? "" },
    }));
  };
  return (
    <>
      <FleetCanvas
        graph={graph}
        stacks={stacks}
        layout={layout}
        shapeKey={key}
        environments={environments}
        selection={selection}
        onSelect={setPicked}
        onLink={requestLink}
        onToggleStack={toggleStack}
      />
      <SettingsSearchTarget id={props.footerId}>
        <FleetDetails
          {...props}
          graph={graph}
          stacks={stacks}
          environments={environments}
          connectProblem={connectProblem}
          selection={selection}
          onSelect={setPicked}
          onLinkFrom={(sourceId) => requestLink(sourceId, null)}
          onToggleStack={toggleStack}
        />
      </SettingsSearchTarget>
      {linkRequest ? (
        <LinkEnvironmentDialog
          key={linkRequest.serial}
          environmentId={linkRequest.environmentId}
          open={linkRequest.open}
          prefill={linkRequest.prefill}
          onOpenChange={(open) =>
            setLinkRequest((current) => (current === null ? null : { ...current, open }))
          }
        />
      ) : null}
    </>
  );
}

interface FleetSceneProps {
  readonly graph: FleetGraph;
  readonly stacks: ReadonlyArray<FleetStack>;
  readonly layout: FleetLayout;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly selection: FleetFocus | null;
  readonly onSelect: (focus: FleetFocus | null) => void;
  readonly onLink: (sourceId: string, targetId: string | null) => void;
  readonly onToggleStack: (stackId: string) => void;
}

function FleetCanvas({ shapeKey, ...scene }: FleetSceneProps & { readonly shapeKey: string }) {
  const gt = useGT();
  const { layout, onSelect } = scene;
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  // A view the user set by hand holds until the map's shape changes; otherwise it fits itself.
  const [manual, setManual] = useState<{
    readonly key: string;
    readonly view: FleetViewTransform;
    /** Set by the buttons and keys, whose jump is eased; a drag or pinch tracks the hand. */
    readonly glide: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    readonly pointerId: number;
    readonly key: string;
    readonly x: number;
    readonly y: number;
    readonly origin: FleetViewTransform;
    moved: boolean;
  } | null>(null);
  // The canvas is as tall as the fitted map wants, so the height never feeds back into the fit.
  const size =
    width === null ? null : { width, height: fleetCanvasHeight(layout, width, CANVAS_HEIGHT) };
  // A new shape drops the held view for good: returning to an old shape must fit, not restore
  // a pan made before the map changed.
  if (manual !== null && manual.key !== "" && manual.key !== shapeKey) {
    setManual({ ...manual, key: "" });
  }
  const held = manual?.key === shapeKey ? manual : null;
  const view = held?.view ?? (size === null ? null : fitFleetLayout(layout, size));
  const glide = manual !== null && (held === null || held.glide);
  const setView = (next: FleetViewTransform, eased: boolean) =>
    setManual({ key: shapeKey, view: next, glide: eased });
  const zoom = (
    factor: number,
    anchor?: { readonly x: number; readonly y: number },
    eased = true,
  ) => {
    if (view === null || size === null) return;
    setView(
      zoomFleetView(
        view,
        factor,
        anchor ?? { x: size.width / 2, y: size.height / 2 },
        fitFleetLayout(layout, size).scale,
      ),
      eased,
    );
  };
  // Keeps the entry so the scene eases back to the fit; its stale key marks it as not held.
  const fit = () => setManual((current) => (current === null ? null : { ...current, key: "" }));
  const onWheel = useEffectEvent((event: WheelEvent) => {
    // Plain scrolling stays the page's; a pinch or Ctrl/Cmd + wheel zooms the map.
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    zoom(
      Math.exp(-event.deltaY * 0.01),
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      false,
    );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the canvas with ResizeObserver, and React's wheel listener is passive so it cannot stop the page zooming
  useEffect(() => {
    if (canvas === null) return;
    const stopObserving = observeResize(canvas, ([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stopObserving();
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [canvas]);

  // Reads the view inside the updater so the scene's props stay the same while panning.
  const reveal = (rect: FleetRect) => {
    if (size === null) return;
    setManual((current) => {
      const shown = current?.key === shapeKey ? current.view : fitFleetLayout(layout, size);
      const left = rect.x * shown.scale + shown.x;
      const top = rect.y * shown.scale + shown.y;
      const inside =
        left >= 0 &&
        top >= 0 &&
        left + rect.width * shown.scale <= size.width &&
        top + rect.height * shown.scale <= size.height;
      if (inside) return current;
      return {
        key: shapeKey,
        glide: true,
        view: {
          scale: shown.scale,
          x: size.width / 2 - (rect.x + rect.width / 2) * shown.scale,
          y: size.height / 2 - (rect.y + rect.height / 2) * shown.scale,
        },
      };
    });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // One pointer owns a drag: a second finger neither restarts it nor ends it.
    if (event.button !== 0 || view === null || drag.current !== null) return;
    if ((event.target as Element).closest("[data-fleet-item]")) return;
    drag.current = {
      pointerId: event.pointerId,
      key: shapeKey,
      x: event.clientX,
      y: event.clientY,
      origin: view,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    // The map was laid out again mid-drag, so the origin belongs to a view that is gone.
    if (current.key !== shapeKey) {
      drag.current = null;
      setDragging(false);
      return;
    }
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    if (!current.moved) setDragging(true);
    current.moved = true;
    setView({ ...current.origin, x: current.origin.x + dx, y: current.origin.y + dy }, false);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (!current.moved && !cancelled) onSelect(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "+" || event.key === "=") zoom(1.25);
    else if (event.key === "-") zoom(0.8);
    else if (event.key === "0") fit();
    else if (event.key === "Escape") onSelect(null);
    else return;
    event.preventDefault();
  };

  return (
    <>
      <div
        ref={setCanvas}
        data-dragging={dragging || undefined}
        data-glide={glide || undefined}
        className="relative min-h-65 cursor-grab touch-none overflow-clip rounded-t-xl bg-background/50 select-none data-dragging:cursor-grabbing data-glide:transition-[background-size,background-position] data-glide:duration-200 data-glide:ease-out motion-reduce:transition-none"
        style={
          view === null || size === null
            ? undefined
            : {
                height: size.height,
                backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1.5px)",
                backgroundSize: `${24 * view.scale}px ${24 * view.scale}px`,
                backgroundPosition: `${view.x}px ${view.y}px`,
              }
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endDrag(event, false)}
        onPointerCancel={(event) => endDrag(event, true)}
        onLostPointerCapture={(event) => endDrag(event, true)}
        onKeyDown={onKeyDown}
      >
        {view === null ? null : (
          <div
            data-fleet-scene
            className="absolute top-0 left-0 origin-top-left in-data-dragging:will-change-transform in-data-glide:transition-transform in-data-glide:duration-200 in-data-glide:ease-out motion-reduce:transition-none"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          >
            <FleetScene {...scene} onReveal={reveal} />
          </div>
        )}
      </div>
      {/* Below the canvas, not over it: nothing on the map can end up under the controls. */}
      <div className="flex items-end justify-between gap-3 bg-background/50 px-3 pb-2">
        <FleetLegend />
        <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-popover/90 p-0.5 shadow-xs/5">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Zoom out")}
            onClick={() => zoom(0.8)}
          >
            <MinusIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Zoom in")}
            onClick={() => zoom(1.25)}
          >
            <PlusIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Fit the map to view")}
            disabled={held === null}
            onClick={fit}
          >
            <MaximizeIcon />
          </Button>
        </div>
      </div>
    </>
  );
}

/** How the two families of line are read: routes by state, links by weight. */
function FleetLegend() {
  const gt = useGT();
  const sample = (state: FleetRouteState) => (
    <svg aria-hidden viewBox="0 0 18 4" className={cn("h-1 w-4.5", ROUTE_STYLES[state].wire)}>
      <path
        d="M0 2H18"
        stroke="currentColor"
        strokeWidth={ROUTE_STYLES[state].width + 0.25}
        strokeDasharray={ROUTE_STYLES[state].dash}
      />
    </svg>
  );
  return (
    <ul
      aria-label={gt("How to read the lines")}
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pb-1 text-2xs text-muted-foreground"
    >
      <li className="flex items-center gap-1.5">
        {sample("in-use")}
        {gt("Route in use")}
      </li>
      <li className="flex items-center gap-1.5">
        {sample("standby")}
        {routeStateLabel("standby", gt)}
      </li>
      <li className="flex items-center gap-1.5">
        {sample("down")}
        {routeStateLabel("down", gt)}
      </li>
      <li className="flex items-center gap-1.5">
        <svg aria-hidden viewBox="0 0 22 6" className="h-1.5 w-5.5 text-foreground/70">
          <path d="M0 3L22 0.5V5.5Z" fill="currentColor" />
        </svg>
        {gt("Link, heavier with more access")}
      </li>
    </ul>
  );
}

/** A state short enough for a card. The reason behind it is in the details and the name. */
function connectionStateText(
  node: FleetEnvironmentNode,
  environment: EnvironmentPresentation | undefined,
  refused: boolean,
  gt: GT,
): string {
  if (!node.enabled && node.phase !== "unsupported") {
    return gt("Off", { $context: "environment switched off" });
  }
  if (refused) return gt("Sign-in refused");
  switch (node.phase) {
    case "connected":
      return gt("Connected");
    case "connecting":
      return gt("Connecting…");
    case "reconnecting":
      return environment?.connection.awaitingApproval
        ? gt("Waiting for approval")
        : gt("Reconnecting…");
    case "unsupported":
      return gt("Client not supported");
    case "error":
      return gt("Connection failed");
    case "offline":
      return gt("Offline");
    case "available":
      return gt("Not connected");
  }
}

function environmentStatusText(
  node: FleetEnvironmentNode,
  environment: EnvironmentPresentation | undefined,
  refused: boolean,
  linkCount: number,
  gt: GT,
): string {
  if (node.phase !== "connected") return connectionStateText(node, environment, refused, gt);
  switch (node.outgoing) {
    case "loading":
      return gt("Loading links…");
    case "error":
      return gt("Links could not be loaded");
    case "off":
      return gt("Linked environments is off");
    case "unknown":
      return gt("Links not readable from here");
    case "loaded":
      return gt("{count, plural, =0 {No links out} one {# link out} other {# links out}}", {
        count: linkCount,
      });
  }
}

function connectAvailabilityText(
  availability: Extract<FleetNode, { kind: "connect" }>["availability"],
  gt: GT,
): string {
  switch (availability) {
    case "online":
      return gt("Relay online");
    case "offline":
      return gt("Relay offline");
    case "checking":
      return gt("Checking relay status…");
    case "error":
      return gt("Relay status unavailable");
  }
}

function linkSummary(edge: FleetLinkEdge, gt: GT, m: Messages): string {
  return `${m(accessConfig[edge.link.access].label)}, ${healthLabel(edge.health, gt)}`;
}

function offerText(offer: FleetLinkOffer, target: string, gt: GT): string {
  if (offer.kind !== "link") return gt("Cannot link to this");
  if (offer.path === "code-less") {
    return offer.renews
      ? gt("Renew the link to {target}. No pairing code needed", { target })
      : gt("Link to {target}. No pairing code needed", { target });
  }
  return offer.renews
    ? gt("Renew the link to {target}. Needs a pairing code from it", { target })
    : gt("Link to {target}. Needs a pairing code from it", { target });
}

const COLUMN_TITLES = (gt: GT): Record<FleetColumn, string> => ({
  client: gt("This app"),
  environments: gt("Your environments"),
  targets: gt("Reached through a link"),
});

interface LinkDrag {
  readonly sourceId: string;
  readonly x: number;
  readonly y: number;
  readonly overId: string | null;
}

const FleetScene = memo(function FleetScene({
  graph,
  stacks,
  layout,
  environments,
  selection,
  onSelect,
  onLink,
  onToggleStack,
  onReveal,
}: FleetSceneProps & { readonly onReveal: (rect: FleetRect) => void }) {
  const gt = useGT();
  const m = useMessages();
  const [hover, setHover] = useState<FleetFocus | null>(null);
  const [roving, setRoving] = useState(FLEET_CLIENT_NODE_ID);
  const [linkDrag, setLinkDrag] = useState<LinkDrag | null>(null);
  const handleDrag = useRef<{
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    moved: boolean;
  } | null>(null);
  // A drag ends with a click on the handle it started from; that click must not open the dialog.
  const swallowClick = useRef(false);
  const focus = linkDrag === null ? (hover ?? selection) : null;
  const lit = focus === null ? null : fleetNeighborhood(graph, stacks, focus);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const environmentById = new Map(
    environments.map((environment) => [
      fleetEnvironmentNodeId(environment.environmentId),
      environment,
    ]),
  );
  const links = graph.edges.filter(isLinkEdge);
  const routeEdges = graph.edges.filter(isRouteEdge);
  const focusRects = fleetFocusRects(layout);
  const tabStop = focusRects.has(roving) ? roving : FLEET_CLIENT_NODE_ID;
  const titles = COLUMN_TITLES(gt);
  const isSelected = (kind: FleetFocus["kind"], id: string) =>
    selection?.kind === kind && selection.id === id;
  const fade = (dimmed: boolean) =>
    cn(
      "transition-opacity duration-150 motion-reduce:transition-none",
      dimmed && "opacity-40 forced-colors:opacity-60",
    );
  // Lines run the length of the map and cross each other, so one out of focus fades further
  // than a machine does.
  const fadeLine = (dimmed: boolean) =>
    cn(
      "transition-opacity duration-150 motion-reduce:transition-none",
      dimmed && "opacity-15 forced-colors:opacity-40",
    );
  const linkLit = (edge: FleetLinkEdge) =>
    isSelected("edge", edge.id) || (lit?.edges.has(edge.id) ?? false);
  // Painted last, so the links in focus lie over the ones that are not.
  const paintOrder = lit === null ? links : links.toSorted((a, b) => +linkLit(a) - +linkLit(b));
  const dragOffer = (targetId: string) =>
    linkDrag === null ? null : fleetLinkOffer(graph, linkDrag.sourceId, targetId);
  const nodeDimmed = (id: string) =>
    linkDrag !== null
      ? id !== linkDrag.sourceId && dragOffer(id)?.kind !== "link"
      : lit !== null && !lit.nodes.has(id);
  // By the links it stands for: a host and a member can both be lit through other links.
  const stackLit = (stack: FleetStack) =>
    lit === null || stack.edgeIds.some((id) => lit.edges.has(id));
  const hoverProps = (target: FleetFocus) => ({
    onPointerEnter: () => setHover(target),
    onPointerLeave: () => setHover(null),
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = ARROW_ROVE[event.key];
    const from = (event.target as HTMLElement).closest<HTMLElement>("[data-fleet-node]");
    if (direction === undefined || from === null) return;
    event.preventDefault();
    const next = nextFleetNode(focusRects, from.dataset.fleetNode ?? "", direction);
    const rect = next === null ? undefined : focusRects.get(next);
    if (next === null || rect === undefined) return;
    event.currentTarget
      .querySelector<HTMLElement>(`[data-fleet-node="${CSS.escape(next)}"]`)
      ?.focus({ preventScroll: true });
    onReveal(rect);
  };

  const focusProps = (target: FleetFocus, rect: FleetRect, label: string) => ({
    type: "button" as const,
    "data-fleet-item": "",
    "data-fleet-node": target.id,
    "aria-label": label,
    "aria-pressed": isSelected(target.kind, target.id),
    tabIndex: target.id === tabStop ? 0 : -1,
    style: { left: rect.x, top: rect.y, width: rect.width, height: rect.height },
    onClick: () => onSelect(isSelected(target.kind, target.id) ? null : target),
    onFocus: (event: FocusEvent<HTMLElement>) => {
      setRoving(target.id);
      setHover(target);
      // Tabbing back in can land on a machine panned out of view; a click cannot.
      if (event.currentTarget.matches(":focus-visible")) onReveal(rect);
    },
    onBlur: () => setHover(null),
    ...hoverProps(target),
  });
  const nodeClass = (id: string) =>
    cn(
      "absolute flex cursor-pointer items-center text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:ring-2 aria-pressed:ring-primary aria-pressed:ring-inset forced-colors:focus-visible:outline-2 forced-colors:aria-pressed:outline-2",
      fade(nodeDimmed(id)),
      linkDrag?.overId === id && "ring-2 ring-primary ring-inset",
    );

  const toScene = (event: PointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.closest("[data-fleet-scene]")?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return null;
    const scale = bounds.width / layout.width;
    return { x: (event.clientX - bounds.left) / scale, y: (event.clientY - bounds.top) / scale };
  };
  const dropTargetAt = (sourceId: string, event: PointerEvent<HTMLElement>) => {
    const over = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-fleet-node]")?.dataset.fleetNode;
    return over !== undefined && fleetLinkOffer(graph, sourceId, over).kind === "link"
      ? over
      : null;
  };
  const handleProps = (sourceId: string) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || handleDrag.current !== null) return;
      swallowClick.current = false;
      handleDrag.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
      const current = handleDrag.current;
      if (current === null || current.pointerId !== event.pointerId) return;
      if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 4) {
        return;
      }
      current.moved = true;
      const point = toScene(event);
      if (point === null) return;
      setLinkDrag({ sourceId, ...point, overId: dropTargetAt(sourceId, event) });
    },
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
      const current = handleDrag.current;
      if (current === null || current.pointerId !== event.pointerId) return;
      handleDrag.current = null;
      if (!current.moved) return;
      swallowClick.current = true;
      // Asked again at release: the map can move under a pointer that has stopped.
      const overId = dropTargetAt(sourceId, event);
      setLinkDrag(null);
      if (overId !== null) onLink(sourceId, overId);
    },
    onLostPointerCapture: () => {
      if (handleDrag.current === null) return;
      handleDrag.current = null;
      setLinkDrag(null);
    },
    onClick: () => {
      if (swallowClick.current) {
        swallowClick.current = false;
        return;
      }
      onLink(sourceId, null);
    },
  });

  const dragSource = linkDrag === null ? undefined : layout.handles.get(linkDrag.sourceId);
  const dragTarget = linkDrag?.overId ? nodeById.get(linkDrag.overId) : undefined;

  return (
    <div
      role="group"
      aria-label={gt("Map of your machines")}
      aria-description={gt(
        "Arrow keys move between machines. Enter opens a machine's details, with its routes and links. Tab from an environment reaches its link button. Plus and minus zoom, zero fits the map.",
      )}
      onKeyDown={onKeyDown}
    >
      {layout.columns.map((column) => (
        <p
          key={column.id}
          aria-hidden
          style={{ left: column.x }}
          className="absolute top-0 text-2xs font-medium whitespace-nowrap text-muted-foreground"
        >
          {titles[column.id]}
        </p>
      ))}
      <svg
        width={layout.width}
        height={layout.height}
        className="absolute top-0 left-0 overflow-visible"
        fill="none"
        strokeLinecap="round"
      >
        {routeEdges.map((edge) => {
          const geometry = layout.routes.get(edge.id);
          if (geometry === undefined) return null;
          const style = ROUTE_STYLES[edge.state];
          return (
            <path
              key={edge.id}
              d={geometry.d}
              stroke="currentColor"
              strokeWidth={style.width}
              strokeDasharray={style.dash}
              className={cn(style.wire, fadeLine(lit !== null && !lit.edges.has(edge.id)))}
            />
          );
        })}
        {stacks.map((stack) => {
          const geometry = layout.stacks.get(stack.id);
          if (geometry === undefined) return null;
          const level = accessLevel(stack.access);
          const onPath = stackLit(stack);
          return (
            <g
              key={stack.id}
              className={cn("text-foreground", fadeLine(lit !== null && !onPath))}
              opacity={lit !== null && onPath ? 1 : ACCESS_STROKE_OPACITIES[level]}
            >
              <path
                d={geometry.d}
                stroke="currentColor"
                strokeWidth={ACCESS_STROKE_WIDTHS[level]}
              />
              <path
                d={`M${geometry.arrow.x - 8} ${geometry.arrow.y - 4.5}L${geometry.arrow.x} ${geometry.arrow.y}L${geometry.arrow.x - 8} ${geometry.arrow.y + 4.5}Z`}
                fill="currentColor"
              />
            </g>
          );
        })}
        {paintOrder.map((edge) => {
          const geometry = layout.links.get(edge.id);
          if (geometry === undefined) return null;
          const { arrow } = geometry;
          const selected = isSelected("edge", edge.id);
          const level = accessLevel(edge.link.access);
          const healthy = edge.health.kind === "reachable" && edge.health.expiresInDays === null;
          return (
            <g
              key={edge.id}
              className={cn(
                "pointer-events-none",
                selected ? "text-primary" : healthy ? "text-foreground" : healthTone(edge.health),
                fadeLine(lit !== null && !linkLit(edge)),
              )}
              opacity={linkLit(edge) ? 1 : ACCESS_STROKE_OPACITIES[level]}
            >
              <path
                d={geometry.d}
                stroke="currentColor"
                // Selection also thickens the line, for when colour is forced.
                strokeWidth={(ACCESS_STROKE_WIDTHS[level] ?? 2) + (selected ? 1 : 0)}
                strokeDasharray={healthDash(edge.health)}
              />
              <path
                d={`M${arrow.x - arrow.dir * 7} ${arrow.y - 4}L${arrow.x} ${arrow.y}L${arrow.x - arrow.dir * 7} ${arrow.y + 4}Z`}
                fill="currentColor"
              />
            </g>
          );
        })}
        {/* Pointer shortcut only: each link is also a row in its machines' details. Kept in a
            fixed order apart from the painted lines, so focus never moves one under the pointer. */}
        {links.map((edge) => {
          const geometry = layout.links.get(edge.id);
          if (geometry === undefined) return null;
          const selected = isSelected("edge", edge.id);
          return (
            <path
              key={edge.id}
              aria-hidden
              data-fleet-item=""
              d={geometry.d}
              stroke="transparent"
              strokeWidth="14"
              className="cursor-pointer"
              onClick={() => onSelect(selected ? null : { kind: "edge", id: edge.id })}
              {...hoverProps({ kind: "edge", id: edge.id })}
            >
              <title>
                {gt("Link from {source} to {target}: {summary}", {
                  source: nodeById.get(edge.from)?.label ?? "",
                  target: nodeById.get(edge.to)?.label ?? "",
                  summary: linkSummary(edge, gt, m),
                })}
              </title>
            </path>
          );
        })}
        {linkDrag !== null && dragSource !== undefined ? (
          <path
            d={`M${dragSource.x} ${dragSource.y}C${dragSource.x + 48} ${dragSource.y} ${linkDrag.x - 48} ${linkDrag.y} ${linkDrag.x} ${linkDrag.y}`}
            stroke="currentColor"
            strokeWidth="1.75"
            strokeDasharray="5 4"
            className="pointer-events-none text-primary"
          />
        ) : null}
      </svg>
      {routeEdges.map((edge) => {
        const geometry = layout.routes.get(edge.id);
        if (geometry === undefined) return null;
        const { pill } = geometry;
        return (
          <span
            key={edge.id}
            aria-hidden
            style={{ left: pill.x, top: pill.y, width: pill.width, height: pill.height }}
            className={cn(
              "absolute flex items-center justify-center rounded-full border bg-background px-1.5 text-2xs leading-none text-muted-foreground",
              ROUTE_STYLES[edge.state].pill,
              fadeLine(lit !== null && !lit.edges.has(edge.id)),
            )}
          >
            <span className="truncate">{routeKindLabel(edge.routeKind, gt)}</span>
          </span>
        );
      })}
      {links.map((edge) => {
        const badge = layout.links.get(edge.id)?.badge;
        if (!badge) return null;
        const target = { kind: "edge", id: edge.id } as const;
        return (
          <button
            key={edge.id}
            type="button"
            data-fleet-item=""
            tabIndex={-1}
            aria-pressed={isSelected("edge", edge.id)}
            aria-label={gt("Link from {source} to {target}: {summary}", {
              source: nodeById.get(edge.from)?.label ?? "",
              target: nodeById.get(edge.to)?.label ?? "",
              summary: linkSummary(edge, gt, m),
            })}
            // Hangs off its own lane and grows away from the lanes beside it.
            style={{
              top: badge.y,
              height: badge.height,
              maxWidth: badge.width,
              ...(badge.side === 1
                ? { left: badge.x }
                : { right: layout.width - badge.x - badge.width }),
            }}
            className={cn(
              "absolute flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-1.5 text-2xs leading-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:border-primary aria-pressed:text-primary",
              healthTone(edge.health),
              fadeLine(lit !== null && !lit.edges.has(edge.id)),
            )}
            onClick={() => onSelect(isSelected("edge", edge.id) ? null : target)}
            onFocus={() => setHover(target)}
            onBlur={() => setHover(null)}
            {...hoverProps(target)}
          >
            <AccessMeter access={edge.link.access} />
            <span className="truncate">{m(accessConfig[edge.link.access].label)}</span>
          </button>
        );
      })}
      {stacks.map((stack) => {
        const geometry = layout.stacks.get(stack.id);
        if (geometry === undefined) return null;
        const { face, rect } = geometry;
        const access = m(accessConfig[stack.access].label);
        const count = stack.memberIds.length;
        const summary = gt("{access}. {reachable} of {count} reachable", {
          access,
          reachable: stack.reachable,
          count,
        });
        const troubled = stack.reachable < count;
        const ToggleIcon = stack.expanded ? FoldVerticalIcon : UnfoldVerticalIcon;
        return (
          <div key={stack.id} className={fade(!stackLit(stack))}>
            {stack.expanded ? (
              <div
                aria-hidden
                style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
                className="absolute rounded-xl border border-border/70 bg-foreground/3"
              />
            ) : (
              [8, 4].map((lift) => (
                <div
                  key={lift}
                  aria-hidden
                  style={{
                    left: face.x + lift,
                    top: face.y - lift,
                    width: face.width,
                    height: face.height,
                  }}
                  className="absolute rounded-lg border border-border bg-card"
                />
              ))
            )}
            <button
              {...focusProps(
                { kind: "stack", id: stack.id },
                face,
                gt("{first} to {last}, {count} machines linked from {source}. {summary}", {
                  first: stack.firstLabel,
                  last: stack.lastLabel,
                  count,
                  source: nodeById.get(stack.sourceId)?.label ?? "",
                  summary,
                }),
              )}
              className={cn(
                nodeClass(stack.id),
                "gap-2 px-2.5 pr-8",
                stack.expanded
                  ? "rounded-t-xl"
                  : "rounded-lg border border-foreground/25 bg-card hover:border-foreground/50",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs leading-4 font-semibold text-foreground">
                    {stack.firstLabel} … {stack.lastLabel}
                  </span>
                  <span className="shrink-0 rounded-full bg-muted px-1.5 text-2xs leading-4 text-muted-foreground tabular-nums forced-colors:border">
                    {count}
                  </span>
                </span>
                {stack.expanded ? null : (
                  <span
                    className={cn(
                      "block truncate text-2xs leading-4",
                      troubled ? "text-warning" : "text-muted-foreground",
                    )}
                  >
                    {summary}
                  </span>
                )}
              </span>
            </button>
            <button
              type="button"
              data-fleet-item=""
              tabIndex={stack.id === tabStop ? 0 : -1}
              aria-label={
                stack.expanded ? gt("Collapse these machines") : gt("Show each machine on the map")
              }
              aria-expanded={stack.expanded}
              style={{ left: face.x + face.width - 28, top: face.y + face.height / 2 - 11 }}
              className="absolute flex size-5.5 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={() => onToggleStack(stack.id)}
            >
              <ToggleIcon aria-hidden className="size-3.5" />
            </button>
          </div>
        );
      })}
      {graph.nodes.map((node) => {
        const rect = layout.nodes.get(node.id);
        if (rect === undefined) return null;
        const target = { kind: "node", id: node.id } as const;
        if (node.kind === "client") {
          const ClientIcon = isElectron ? AppWindowIcon : GlobeIcon;
          return (
            <button
              key={node.id}
              {...focusProps(target, rect, node.label)}
              className={cn(
                nodeClass(node.id),
                "gap-2 rounded-full border border-foreground/25 bg-card px-3.5 text-foreground hover:border-foreground/50",
              )}
            >
              <ClientIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-xs font-semibold">{node.label}</span>
            </button>
          );
        }
        const incoming = links.filter((edge) => edge.to === node.id);
        if (node.kind === "target") {
          // One link in names its access here. Several are told apart by the one in focus:
          // hovering or selecting a host shows what that host may do on this machine.
          const focused = incoming.filter((edge) => lit?.edges.has(edge.id));
          const shown =
            incoming.length === 1 ? incoming[0] : focused.length === 1 ? focused[0] : undefined;
          const first = shown ?? incoming.toSorted(byTrouble)[0];
          const compact = rect.height < 32;
          return (
            <button
              key={node.id}
              {...focusProps(
                target,
                rect,
                [
                  node.label,
                  gt("known only through a link"),
                  ...incoming.map((edge) =>
                    gt("from {source}: {summary}", {
                      source: nodeById.get(edge.from)?.label ?? "",
                      summary: linkSummary(edge, gt, m),
                    }),
                  ),
                ].join(", "),
              )}
              className={cn(
                nodeClass(node.id),
                "gap-2 border bg-card text-foreground/90 hover:border-foreground/50 hover:text-foreground",
                compact ? "rounded-md px-2" : "rounded-lg px-2.5",
                first ? healthBorder(first.health) : "border-border",
              )}
            >
              <span className="flex w-3 shrink-0 justify-center">
                {first ? <HealthGlyph health={first.health} /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate",
                    compact ? "text-2xs leading-none" : "text-xs leading-4 font-medium",
                  )}
                >
                  {node.label}
                </span>
                {compact || !first ? null : (
                  <span
                    className={cn(
                      "block truncate text-2xs leading-4",
                      first.health.kind === "reachable" && first.health.expiresInDays === null
                        ? "text-muted-foreground"
                        : healthTone(first.health),
                    )}
                  >
                    {shown === undefined
                      ? gt("{count, plural, one {# link in} other {# links in}}", {
                          count: incoming.length,
                          $context:
                            "how many machines hold a link to this machine; pairs with '# links out'",
                        })
                      : first.health.kind === "reachable" && first.health.expiresInDays === null
                        ? m(accessConfig[first.link.access].label)
                        : `${m(accessConfig[first.link.access].label)} · ${healthLabel(first.health, gt)}`}
                  </span>
                )}
              </span>
              {compact || !shown ? null : (
                <AccessMeter access={shown.link.access} className="text-foreground/70" />
              )}
            </button>
          );
        }
        if (node.kind === "connect") {
          const status = `${gt("Not added")} · ${connectAvailabilityText(node.availability, gt)}`;
          return (
            <button
              key={node.id}
              {...focusProps(
                target,
                rect,
                gt("{label}, on your T3 Connect account, not added to this app. {status}", {
                  label: node.label,
                  status: connectAvailabilityText(node.availability, gt),
                }),
              )}
              className={cn(
                nodeClass(node.id),
                "gap-2.5 rounded-xl border border-dashed border-foreground/30 bg-card/60 px-3 hover:border-foreground/55",
              )}
            >
              <CloudIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs leading-4 font-semibold text-foreground">
                  {node.label}
                </span>
                <span className="block truncate text-2xs leading-4 text-muted-foreground">
                  {status}
                </span>
              </span>
            </button>
          );
        }
        const environment = environmentById.get(node.id);
        const routes = routeEdges.filter((edge) => edge.to === node.id);
        const status = environmentStatusText(
          node,
          environment,
          routes.length > 0 && routes.every((edge) => edge.state === "refused"),
          links.filter((edge) => edge.from === node.id).length,
          gt,
        );
        // The card's state is short; the name carries the reason and what it leaves unknown.
        const spoken =
          node.phase === "connected"
            ? status
            : gt("{status}. Links unknown", {
                status: environment ? savedBackendStatus(environment, m).text : status,
              });
        const dimmed = !node.enabled || node.phase === "unsupported";
        const handle = layout.handles.get(node.id);
        const over = linkDrag?.overId === node.id;
        return (
          <div key={node.id}>
            <button
              {...focusProps(
                target,
                rect,
                [
                  node.label,
                  spoken,
                  ...routes.map(
                    (edge) =>
                      `${routeKindLabel(edge.routeKind, gt)}: ${routeStateLabel(edge.state, gt)}`,
                  ),
                ].join(", "),
              )}
              className={cn(
                nodeClass(node.id),
                "gap-3 rounded-xl border bg-card px-3 text-card-foreground shadow-sm/5 hover:border-foreground/45",
                dimmed ? "border-dashed border-foreground/25" : "border-foreground/20",
                over && "border-primary",
              )}
            >
              <span
                className={cn(
                  "relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/80 forced-colors:border",
                  dimmed && "opacity-60",
                )}
              >
                <EnvironmentMachineIcon kind={node.machine ?? "server"} className="size-4" />
                <span
                  aria-hidden
                  className={cn(
                    "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-card",
                    node.enabled
                      ? connectionPhaseDotClassName(node.phase)
                      : "bg-muted-foreground/40",
                  )}
                />
              </span>
              <span className={cn("min-w-0 flex-1", dimmed && "opacity-70")}>
                <span className="block truncate text-sm leading-5 font-semibold">{node.label}</span>
                <span
                  className={cn(
                    "block truncate text-2xs leading-4",
                    node.outgoing === "error" && node.phase === "connected"
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {status}
                </span>
              </span>
            </button>
            {handle !== undefined && node.linking === "ready" ? (
              <button
                type="button"
                data-fleet-item=""
                tabIndex={node.id === tabStop ? 0 : -1}
                aria-label={gt("Link {label} to another machine", { label: node.label })}
                style={{ left: handle.x - 9, top: handle.y - 9 }}
                onFocus={(event) => {
                  // Its own bounds: it straddles the card's edge, so the card can be in view
                  // while half the handle is not.
                  if (event.currentTarget.matches(":focus-visible")) {
                    onReveal({ x: handle.x - 9, y: handle.y - 9, width: 18, height: 18 });
                  }
                }}
                className={cn(
                  "absolute flex size-4.5 cursor-crosshair touch-none items-center justify-center rounded-full bg-primary text-primary-foreground outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-inset motion-safe:transition-transform motion-safe:duration-150 forced-colors:border",
                  fade(nodeDimmed(node.id)),
                )}
                {...handleProps(node.id)}
              >
                <PlusIcon aria-hidden className="size-3" strokeWidth={2.5} />
              </button>
            ) : null}
          </div>
        );
      })}
      {linkDrag !== null ? (
        <DragHint x={linkDrag.x} y={linkDrag.y}>
          {dragTarget
            ? offerText(dragOffer(dragTarget.id)!, dragTarget.label, gt)
            : gt("Drop on a machine to link {source} to it", {
                source: nodeById.get(linkDrag.sourceId)?.label ?? "",
              })}
        </DragHint>
      ) : null}
    </div>
  );
});

function DragHint({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <p
      role="status"
      style={{ left: x + 14, top: y + 14 }}
      className="pointer-events-none absolute z-10 rounded-md border border-border bg-popover px-2 py-1 text-2xs whitespace-nowrap text-popover-foreground shadow-sm/5"
    >
      {children}
    </p>
  );
}
