import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type ConnectionRouteKind,
  connectionRouteId,
  connectionRouteKind,
  connectionRouteLabelText,
  connectionRoutes,
  routeHttpBaseUrl,
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
  ArrowUpDownIcon,
  CheckIcon,
  CircleHelpIcon,
  CloudIcon,
  GlobeIcon,
  MaximizeIcon,
  MinusIcon,
  PlusIcon,
  SearchIcon,
  TriangleAlertIcon,
  UnfoldVerticalIcon,
  FoldVerticalIcon,
  LinkIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ComponentProps,
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
import { useStableCallback } from "~/hooks/useStableCallback";
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
import { connectionPhaseTone } from "../connectionPhaseTone";
import { StatusDot } from "../ui/status-dot";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Badge } from "../ui/badge";
import { Button, ContentButton } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildFleetGraph,
  anchorFleetView,
  fitFleetLayout,
  fleetCanvasHeight,
  FLEET_CLIENT_NODE_ID,
  fleetDrawnLinkId,
  fleetEnvironmentNodeId,
  fleetFocusRects,
  fleetLinkAction,
  fleetLinkOffer,
  fleetMoreNodeId,
  fleetNeighborhood,
  fleetNodesInBox,
  fleetSearch,
  fleetLayoutWidth,
  fleetSummary,
  fleetShapeKey,
  fleetStackPartial,
  fleetStacks,
  fleetTwoWayLinks,
  type FleetArrow,
  type FleetColumn,
  type FleetDirection,
  type FleetEnvironmentInput,
  type FleetEnvironmentNode,
  type FleetFocus,
  type FleetFoldGroup,
  type FleetGraph,
  type FleetHeldView,
  type FleetLayout,
  type FleetLinkAction,
  type FleetLinkEdge,
  type FleetLinkOffer,
  type FleetNode,
  type FleetRect,
  type FleetRouteEdge,
  type FleetRouteState,
  type FleetStack,
  type FleetViewTransform,
  isLinkEdge,
  isRouteEdge,
  layoutFleetGraph,
  linkNeedsAttention,
  linkTroubleRank,
  worseLinkHealth,
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
import { LinkSeveralEnvironmentsDialog } from "./LinkSeveralEnvironments";
import { savedBackendStatus } from "./SavedEnvironmentRows";
import { SettingsSearchTarget } from "./settingsLayout";

type GT = ReturnType<typeof useGT>;
type Messages = ReturnType<typeof useMessages>;

/** One ordinal scale for access, read only to full access: a link's line gets heavier and darker. */
const ACCESS_STROKE_WIDTHS = [1, 1.25, 1.5, 1.75, 2];
const ACCESS_STROKE_OPACITIES = [0.4, 0.5, 0.62, 0.76, 0.9];
/** Short maps get a short canvas; a tall one grows to this, then the fit shrinks it or it pans. */
const CANVAS_HEIGHT = { min: 180, max: 840 };
const ARROW_ROVE: Record<string, FleetDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};
const NO_STACKS: ReadonlySet<string> = new Set();
const NO_SELECTION: ReadonlySet<string> = new Set();
/** The link handle's size: the app's small round icon button, centred on the card's edge. */
const HANDLE = 22;
/** Search centres a machine at a scale it can be read at, however far out the map was. */
const FOUND_MIN_SCALE = 0.85;

/** What an opened stack adds fades in over the same time the view takes to make room for it. */
const APPEAR =
  "transition-opacity duration-200 ease-out starting:opacity-0 motion-reduce:transition-none";

/** Dashes repeat a link's health without colour, one pattern per kind of trouble. */
function healthDash(health: PeerLinkHealth): string | undefined {
  if (health.kind === "expired") return "1 5";
  if (health.kind === "failing") return "8 3 1 3";
  return health.kind === "unreachable" ? "5 4" : undefined;
}

/** Worst first: a machine several hosts link to wears the health of its most troubled link. */
const byTrouble = (left: FleetLinkEdge, right: FleetLinkEdge) =>
  linkTroubleRank(left.health) - linkTroubleRank(right.health);

/** A link's health as the map's controls style it: a machine's outline and a name's colour. */
function healthState(
  health: PeerLinkHealth,
): "expired" | "failing" | "unreachable" | "expiring" | "ok" {
  if (health.kind === "expired" || health.kind === "failing" || health.kind === "unreachable") {
    return health.kind;
  }
  return health.expiresInDays === null ? "ok" : "expiring";
}

/** How each route state is drawn: the one in use stands out, the rest stay quiet. */
const ROUTE_STYLES: Record<
  FleetRouteState,
  {
    readonly wire: string;
    readonly width: number;
    readonly dash?: string;
    readonly badge: NonNullable<ComponentProps<typeof Badge>["variant"]>;
  }
> = {
  "in-use": { wire: "text-success", width: 1.75, badge: "success" },
  standby: { wire: "text-muted-foreground/60", width: 1, badge: "secondary" },
  trying: { wire: "text-warning", width: 1, dash: "1 4", badge: "warning" },
  down: { wire: "text-muted-foreground/60", width: 1, dash: "4 4", badge: "unavailable" },
  idle: { wire: "text-muted-foreground/40", width: 1, dash: "4 4", badge: "unavailable" },
  refused: { wire: "text-destructive/80", width: 1, dash: "4 4", badge: "error" },
  offered: { wire: "text-muted-foreground/50", width: 1, dash: "1 4", badge: "outline" },
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
        ...(connectionRouteKind(route) === "tailnet" &&
        routeHttpBaseUrl(route)?.startsWith("https:") === true
          ? { label: connectionRouteLabelText(route, m) }
          : {}),
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

/**
 * The layout for the graph's current shape at the canvas's width; a health or status change
 * reuses the last one.
 */
function useFleetLayout(
  graph: FleetGraph,
  stacks: ReadonlyArray<FleetStack>,
  shapeKey: string,
  canvasWidth: number | null,
) {
  const width = canvasWidth === null ? undefined : fleetLayoutWidth(canvasWidth);
  const key = `${shapeKey}\n${width}`;
  const [laid, setLaid] = useState(() => ({ key, layout: layoutFleetGraph(graph, stacks, width) }));
  if (laid.key === key) return laid;
  const next = { key, layout: layoutFleetGraph(graph, stacks, width) };
  setLaid(next);
  return next;
}

interface LinkRequest {
  readonly serial: number;
  readonly environmentId: EnvironmentId;
  readonly prefill: LinkEnvironmentPrefill;
  readonly open: boolean;
}

interface BatchRequest {
  readonly serial: number;
  readonly environmentId: EnvironmentId;
  readonly preset: ReadonlyArray<EnvironmentId>;
  /** The machines were dropped on or selected for this link, so the dialog lists only them. */
  readonly presetOnly: boolean;
  readonly open: boolean;
}

/** A drop the client cannot link in one go, explained where it happened. */
type CodeOnlyDrop = Extract<FleetLinkAction, { kind: "code-only" }>;

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
  const key = fleetShapeKey(graph, stacks);
  const [picked, setPicked] = useState<FleetFocus | null>(null);
  // Machines ticked for a batch link: apart from `picked`, which is what the details show.
  const [ticked, setTicked] = useState(NO_SELECTION);
  // The machine a search landed on inside a stack, for the stack's list to scroll to.
  const [found, setFound] = useState<string | null>(null);
  const [linkRequest, setLinkRequest] = useState<LinkRequest | null>(null);
  const [batchRequest, setBatchRequest] = useState<BatchRequest | null>(null);
  const [dropped, setDropped] = useState<CodeOnlyDrop | null>(null);
  const pairs = fleetTwoWayLinks(graph);
  const present =
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
  // Either link of a two-way link selects the one line drawn for both.
  const selection =
    present?.kind === "edge" ? { ...present, id: fleetDrawnLinkId(pairs, present.id) } : present;
  // A machine that left the map leaves the selection with it.
  const selected =
    ticked.size === 0
      ? NO_SELECTION
      : new Set(graph.nodes.filter((node) => ticked.has(node.id)).map((node) => node.id));
  const toggleStack = (stackId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(stackId)) next.add(stackId);
      return next;
    });
  const tick = (ids: ReadonlyArray<string>, mode: "toggle" | "add") =>
    setTicked((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (mode === "toggle" && next.delete(id)) continue;
        next.add(id);
      }
      return next;
    });
  const openLinkDialog = (
    environmentId: EnvironmentId,
    offer: Extract<FleetLinkOffer, { kind: "link" }> | null,
  ) => {
    setDropped(null);
    setLinkRequest((current) => ({
      serial: (current?.serial ?? 0) + 1,
      environmentId,
      open: true,
      prefill:
        offer === null
          ? { choice: null }
          : offer.target.kind === "machine"
            ? { choice: offer.target.environmentId }
            : {
                choice: ANOTHER_ADDRESS,
                address: offer.target.address ?? "",
                ...(offer.target.through ? { through: offer.target.through } : {}),
              },
    }));
  };
  /** One link from `sourceId` to `targetId`, whatever is selected. */
  const requestOneLink = (sourceId: string, targetId: string) => {
    const offer = fleetLinkOffer(graph, sourceId, targetId);
    if (offer.kind === "link") openLinkDialog(offer.sourceEnvironmentId, offer);
  };
  // One way in for every gesture: the handle, a drop, the details and the toolbar.
  const requestLink = (sourceId: string, targetId: string | null) => {
    const action = fleetLinkAction(graph, stacks, selected, sourceId, targetId);
    if (action === null) return;
    if (action.kind === "code-only") {
      setDropped(action);
      return;
    }
    if (action.kind === "batch") {
      setDropped(null);
      setBatchRequest((current) => ({
        serial: (current?.serial ?? 0) + 1,
        environmentId: action.sourceEnvironmentId,
        preset: action.environmentIds,
        presetOnly: true,
        open: true,
      }));
      return;
    }
    openLinkDialog(action.sourceEnvironmentId, action.offer);
  };
  const requestBatch = (sourceId: string) => {
    const source = graph.nodes.find((node) => node.id === sourceId);
    if (source?.kind !== "environment" || source.linking !== "ready") return;
    const action = fleetLinkAction(graph, stacks, selected, sourceId, null);
    setDropped(null);
    setBatchRequest((current) => ({
      serial: (current?.serial ?? 0) + 1,
      environmentId: source.environmentId,
      preset: action?.kind === "batch" ? action.environmentIds : [],
      presetOnly: false,
      open: true,
    }));
  };
  const select = (focus: FleetFocus | null) => {
    setPicked(focus);
    setFound(null);
  };
  return (
    <>
      <SettingsSearchTarget id={props.footerId}>
        <FleetCanvas
          graph={graph}
          stacks={stacks}
          shapeKey={key}
          environments={environments}
          selection={selection}
          selected={selected}
          onSelect={select}
          onTick={tick}
          onClearTicked={() => setTicked(NO_SELECTION)}
          onLink={requestLink}
          onLinkSeveral={requestBatch}
          dropped={dropped}
          onLinkOne={requestOneLink}
          onDismissDropped={() => setDropped(null)}
          onToggleStack={toggleStack}
          onFind={(stackId, memberId) => {
            setPicked({ kind: "stack", id: stackId });
            setFound(memberId);
          }}
        />
      </SettingsSearchTarget>
      <FleetDetails
        {...props}
        graph={graph}
        stacks={stacks}
        environments={environments}
        connectProblem={connectProblem}
        selection={selection}
        found={found}
        onSelect={select}
        onLinkFrom={(sourceId) => requestLink(sourceId, null)}
        onLinkBack={(edge) => requestOneLink(edge.to, edge.from)}
        onToggleStack={toggleStack}
      />
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
      {batchRequest ? (
        <LinkSeveralEnvironmentsDialog
          key={batchRequest.serial}
          environmentId={batchRequest.environmentId}
          open={batchRequest.open}
          preset={batchRequest.preset}
          presetOnly={batchRequest.presetOnly}
          onOpenChange={(open) =>
            setBatchRequest((current) => (current === null ? null : { ...current, open }))
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
  /** Machines ticked for a batch link. */
  readonly selected: ReadonlySet<string>;
  readonly onSelect: (focus: FleetFocus | null) => void;
  readonly onTick: (ids: ReadonlyArray<string>, mode: "toggle" | "add") => void;
  readonly onLink: (sourceId: string, targetId: string | null) => void;
  readonly onToggleStack: (stackId: string) => void;
}

interface FleetCanvasProps extends Omit<FleetSceneProps, "layout"> {
  /** The graph's shape. The canvas lays it out at its own width. */
  readonly shapeKey: string;
  readonly onClearTicked: () => void;
  readonly onLinkSeveral: (sourceId: string) => void;
  readonly dropped: CodeOnlyDrop | null;
  readonly onLinkOne: (sourceId: string, targetId: string) => void;
  readonly onDismissDropped: () => void;
  /** A search landed on a machine drawn only inside a stack. */
  readonly onFind: (stackId: string, memberId: string) => void;
}

function FleetCanvas({
  shapeKey: graphKey,
  onClearTicked,
  onLinkSeveral,
  dropped,
  onLinkOne,
  onDismissDropped,
  onFind,
  ...scene
}: FleetCanvasProps) {
  const gt = useGT();
  const { graph, stacks, selection, selected, onSelect, onTick } = scene;
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const { key: layoutKey, layout } = useFleetLayout(graph, stacks, graphKey, width);
  const [query, setQuery] = useState("");
  // A held view lasts while the map keeps its shape, whatever the width; otherwise it fits itself.
  const [manual, setManual] = useState<FleetHeldView | null>(null);
  // What was last drawn, to tell a stack opening or closing from any other change of shape.
  const [drawn, setDrawn] = useState({ graphKey, layoutKey, layout, stacks });
  const [dragging, setDragging] = useState(false);
  // The selection box, in canvas pixels, while Shift is held through a drag on empty canvas.
  const [box, setBox] = useState<FleetRect | null>(null);
  const drag = useRef<{
    readonly pointerId: number;
    readonly key: string;
    readonly mode: "pan" | "box";
    readonly x: number;
    readonly y: number;
    readonly left: number;
    readonly top: number;
    readonly origin: FleetViewTransform;
    moved: boolean;
  } | null>(null);
  if (drawn.layoutKey !== layoutKey) {
    setDrawn({ graphKey, layoutKey, layout, stacks });
    if (drawn.graphKey !== graphKey) {
      const toggled = stacks.find((stack) =>
        drawn.stacks.some((was) => was.id === stack.id && was.expanded !== stack.expanded),
      );
      const before = toggled === undefined ? undefined : drawn.layout.stacks.get(toggled.id);
      const after = toggled === undefined ? undefined : layout.stacks.get(toggled.id);
      if (width !== null && before !== undefined && after !== undefined) {
        // The stack stays where it is and the rest makes room, in the one render that opens it.
        const was = manual?.key === drawn.graphKey ? manual : null;
        const from = {
          width,
          height: was?.height ?? fleetCanvasHeight(drawn.layout, width, CANVAS_HEIGHT),
        };
        setManual(
          anchorFleetView({
            key: graphKey,
            from: {
              key: drawn.graphKey,
              held: was,
              view: was?.view ?? fitFleetLayout(drawn.layout, from),
              size: from,
              face: before.face,
            },
            stack: after,
            layout,
            bounds: CANVAS_HEIGHT,
          }),
        );
      } else if (manual !== null && manual.key !== "") {
        // Any other new shape drops the held view for good: returning to an old shape must
        // fit, not restore a pan made before the map changed.
        setManual({ ...manual, key: "" });
      }
    }
  }
  const held = manual?.key === graphKey ? manual : null;
  // Not measured: the height follows from the layout and the view, so it never feeds back.
  const size =
    width === null
      ? null
      : { width, height: held?.height ?? fleetCanvasHeight(layout, width, CANVAS_HEIGHT) };
  const view = held?.view ?? (size === null ? null : fitFleetLayout(layout, size));
  const glide = manual !== null && (held === null || held.glide);
  const setView = (next: FleetViewTransform, eased: boolean) => {
    if (size === null) return;
    setManual({ key: graphKey, view: next, height: size.height, glide: eased, undo: null });
  };
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
  const reveal = useStableCallback((rect: FleetRect) => {
    if (size === null) return;
    setManual((current) => {
      const shown = current?.key === graphKey ? current.view : fitFleetLayout(layout, size);
      const left = rect.x * shown.scale + shown.x;
      const top = rect.y * shown.scale + shown.y;
      const inside =
        left >= 0 &&
        top >= 0 &&
        left + rect.width * shown.scale <= size.width &&
        top + rect.height * shown.scale <= size.height;
      if (inside) return current;
      return {
        key: graphKey,
        height: size.height,
        glide: true,
        undo: null,
        view: {
          scale: shown.scale,
          x: size.width / 2 - (rect.x + rect.width / 2) * shown.scale,
          y: size.height / 2 - (rect.y + rect.height / 2) * shown.scale,
        },
      };
    });
  });
  const centre = (rect: FleetRect) => {
    if (size === null || view === null) return;
    const scale = Math.max(view.scale, FOUND_MIN_SCALE);
    setView(
      {
        scale,
        x: size.width / 2 - (rect.x + rect.width / 2) * scale,
        y: size.height / 2 - (rect.y + rect.height / 2) * scale,
      },
      true,
    );
  };

  const matchIds = fleetSearch(graph, query);
  const matches = query.trim() === "" ? null : new Set(matchIds);
  const goToFirstMatch = () => {
    const first = matchIds[0];
    if (first === undefined) return;
    const rect = layout.nodes.get(first);
    if (rect !== undefined) {
      onSelect({ kind: "node", id: first });
      centre(rect);
      canvas
        ?.querySelector<HTMLElement>(`[data-fleet-node="${CSS.escape(first)}"]`)
        ?.focus({ preventScroll: true });
      return;
    }
    // Folded away: its stack's list in the details scrolls to it.
    const stack = stacks.find((entry) => entry.memberIds.includes(first));
    const face = stack === undefined ? undefined : layout.stacks.get(stack.id)?.face;
    if (stack === undefined || face === undefined) return;
    onFind(stack.id, first);
    centre(face);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // One pointer owns a drag: a second finger neither restarts it nor ends it.
    if (event.button !== 0 || view === null || drag.current !== null) return;
    if ((event.target as Element).closest("[data-fleet-item]")) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    drag.current = {
      pointerId: event.pointerId,
      key: layoutKey,
      mode: event.shiftKey ? "box" : "pan",
      x: event.clientX,
      y: event.clientY,
      left: bounds.left,
      top: bounds.top,
      origin: view,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const boxAt = (current: NonNullable<typeof drag.current>, event: PointerEvent): FleetRect => ({
    x: Math.min(current.x, event.clientX) - current.left,
    y: Math.min(current.y, event.clientY) - current.top,
    width: Math.abs(event.clientX - current.x),
    height: Math.abs(event.clientY - current.y),
  });
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    // The map was laid out again mid-drag, so the origin belongs to a view that is gone.
    if (current.key !== layoutKey) {
      drag.current = null;
      setDragging(false);
      setBox(null);
      return;
    }
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    current.moved = true;
    if (current.mode === "box") {
      setBox(boxAt(current, event));
      return;
    }
    setDragging(true);
    setView({ ...current.origin, x: current.origin.x + dx, y: current.origin.y + dy }, false);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    setBox(null);
    if (cancelled) return;
    if (!current.moved) {
      if (current.mode === "pan") onSelect(null);
      return;
    }
    if (current.mode !== "box" || current.key !== layoutKey) return;
    const drawn = boxAt(current, event);
    // The box is in screen space: a zoom made mid-drag moved the map under it.
    const origin = view ?? current.origin;
    onTick(
      fleetNodesInBox(layout, {
        x: (drawn.x - origin.x) / origin.scale,
        y: (drawn.y - origin.y) / origin.scale,
        width: drawn.width / origin.scale,
        height: drawn.height / origin.scale,
      }),
      "add",
    );
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

  const sources = graph.nodes.filter(
    (node): node is FleetEnvironmentNode => node.kind === "environment" && node.linking === "ready",
  );
  // The environment in the details is the one the user means; a lone one needs no asking.
  const source =
    sources.find((node) => selection?.kind === "node" && node.id === selection.id) ??
    (sources.length === 1 ? sources[0] : undefined);
  const selectSeveral = gt("Shift-click or Shift-drag to select several");

  return (
    <div className="flex flex-col gap-2 px-1.5 pt-2 pb-1.5">
      <div className="flex flex-wrap items-center gap-2 px-0.5">
        <InputGroup className="min-w-40 flex-1">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            size="sm"
            type="search"
            value={query}
            aria-label={gt("Find a machine on the map")}
            placeholder={gt("Find a machine")}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                goToFirstMatch();
              } else if (event.key === "Escape" && query !== "") {
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
        </InputGroup>
        {matches === null ? null : (
          <p role="status" className="min-w-0 text-caption text-muted-foreground">
            {matchIds.length === 0
              ? gt("No machine by that name")
              : gt("{count, plural, one {# match} other {# matches}}", {
                  count: matchIds.length,
                  $context: "how many machines a search by name found",
                })}
          </p>
        )}
        {selected.size > 0 ? (
          <span className="flex items-center gap-2 text-caption text-foreground">
            <span role="status" className="tabular-nums">
              {gt("{count, plural, one {# selected} other {# selected}}", {
                count: selected.size,
                $context: "how many machines are selected on a map",
              })}
            </span>
            <Button size="sm" variant="secondary" onClick={onClearTicked}>
              {gt("Clear", { $context: "clears the selection of machines" })}
            </Button>
          </span>
        ) : null}
        {sources.length === 0 ? null : source !== undefined ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button size="sm" variant="secondary" onClick={() => onLinkSeveral(source.id)}>
                  <LinkIcon />
                  {gt("Link several…")}
                </Button>
              }
            />
            <TooltipPopup>{selectSeveral}</TooltipPopup>
          </Tooltip>
        ) : (
          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button size="sm" variant="secondary">
                        <LinkIcon />
                        {gt("Link several…")}
                      </Button>
                    }
                  />
                }
              />
              <TooltipPopup>{selectSeveral}</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end">
              {sources.map((node) => (
                <MenuItem key={node.id} onClick={() => onLinkSeveral(node.id)}>
                  {gt("From {source}", {
                    source: node.label,
                    $context: "menu item: link several machines from this environment",
                  })}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        )}
        <Popover>
          <PopoverTrigger
            render={
              <Button size="icon-sm" variant="secondary" aria-label={gt("How to use the map")}>
                <CircleHelpIcon />
              </Button>
            }
          />
          <PopoverPopup align="end" width="sm" padding="compact">
            <ul className="list-disc space-y-1 pl-4 text-meta text-muted-foreground">
              <li>{gt("Select a machine to manage it.")}</li>
              {sources.length === 0 ? null : (
                <>
                  <li>{gt("Drag a plus onto a machine to link them.")}</li>
                  <li>{selectSeveral}</li>
                </>
              )}
              <li>{gt("A link reaches one machine and stops there.")}</li>
            </ul>
          </PopoverPopup>
        </Popover>
      </div>
      {dropped === null ? null : (
        <CodeOnlyNotice
          graph={graph}
          dropped={dropped}
          onLinkOne={onLinkOne}
          onDismiss={onDismissDropped}
        />
      )}
      {/* One step deeper than the page surface; route badges and link pills share the same fill. */}
      <div className="overflow-clip rounded-lg border border-border bg-(--map-canvas-background)">
        <div
          ref={setCanvas}
          data-dragging={dragging || undefined}
          data-glide={glide || undefined}
          className="relative min-h-45 cursor-grab touch-none overflow-clip select-none data-dragging:cursor-grabbing data-glide:transition-[height,background-size,background-position] data-glide:duration-200 data-glide:ease-out motion-reduce:transition-none"
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
              <FleetScene {...scene} layout={layout} matches={matches} onReveal={reveal} />
            </div>
          )}
          {box === null ? null : (
            <div
              aria-hidden
              style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
              className="pointer-events-none absolute rounded-sm border border-primary bg-primary/10 forced-colors:border-2"
            />
          )}
        </div>
        {/* In the surface's corners, below the canvas: nothing on the map can end up under them. */}
        <div className="flex items-center justify-between gap-3 px-2 pt-1 pb-2">
          <FleetLegend twoWay={fleetTwoWayLinks(graph).size > 0} />
          <div className="flex shrink-0 items-center gap-2">
            <FleetAttention graph={graph} />
            <Group>
              <Button
                size="icon-xs"
                variant="secondary"
                aria-label={gt("Zoom out")}
                onClick={() => zoom(0.8)}
              >
                <MinusIcon />
              </Button>
              <GroupSeparator />
              <Button
                size="icon-xs"
                variant="secondary"
                aria-label={gt("Zoom in")}
                onClick={() => zoom(1.25)}
              >
                <PlusIcon />
              </Button>
              <GroupSeparator />
              <Button
                size="icon-xs"
                variant="secondary"
                aria-label={gt("Fit the map to view")}
                disabled={held === null}
                onClick={fit}
              >
                <MaximizeIcon />
              </Button>
            </Group>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Links in trouble, as one warning beside the legend; each is marked on the map itself. */
function FleetAttention({ graph }: { readonly graph: FleetGraph }) {
  const gt = useGT();
  const summary = fleetSummary(graph);
  const attention = graph.edges
    .filter(isLinkEdge)
    .filter((edge) => linkNeedsAttention(edge.health)).length;
  if (attention === 0) return null;
  const label = [
    summary.links === null
      ? gt("{machines, plural, one {# machine} other {# machines}}", { machines: summary.machines })
      : gt(
          "{machines, plural, one {# machine} other {# machines}}, {links, plural, =0 {no links} one {# link} other {# links}}",
          { machines: summary.machines, links: summary.links },
        ),
    gt("{count, plural, one {# needs attention} other {# need attention}}", {
      count: attention,
      $context: "after a count of links: how many of those links have a problem",
    }),
  ].join(", ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={label}
            className="inline-flex size-6 items-center justify-center rounded-badge text-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        }
      >
        <TriangleAlertIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** How the two families of line are read: routes by state, links by weight. */
function FleetLegend({ twoWay }: { readonly twoWay: boolean }) {
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
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption whitespace-nowrap text-muted-foreground"
    >
      <li className="flex items-center gap-1.5">
        {sample("in-use")}
        {routeStateLabel("in-use", gt)}
      </li>
      <li className="flex items-center gap-1.5">
        {sample("standby")}
        {routeStateLabel("standby", gt)}
      </li>
      <li className="flex items-center gap-1.5">
        {sample("down")}
        {gt("Offline")}
      </li>
      <li className="flex items-center gap-1.5">
        <svg aria-hidden viewBox="0 0 22 6" className="h-1.5 w-5.5 text-foreground/70">
          <path d="M0 3L22 0.5V5.5Z" fill="currentColor" />
        </svg>
        {gt("Link", { $context: "noun, in a map legend: a line joining two linked machines" })}
      </li>
      {twoWay ? (
        <li className="flex items-center gap-1.5">
          <svg aria-hidden viewBox="0 0 22 8" className="h-2 w-5.5 text-foreground/70">
            <path d="M5 4H17" stroke="currentColor" strokeWidth="1.75" />
            <path d="M0 4L6 0.5V7.5ZM22 4L16 0.5V7.5Z" fill="currentColor" />
          </svg>
          {gt("Two-way", { $context: "in a map legend: a link that goes both ways" })}
        </li>
      ) : null}
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

/** A link in words, for the pointer and for assistive tech. A two-way link names each direction. */
function linkName(
  edge: FleetLinkEdge,
  back: FleetLinkEdge | undefined,
  labelOf: (id: string) => string,
  gt: GT,
  m: Messages,
): string {
  const source = labelOf(edge.from);
  const target = labelOf(edge.to);
  return back === undefined
    ? gt("Link from {source} to {target}: {summary}", {
        source,
        target,
        summary: linkSummary(edge, gt, m),
      })
    : gt(
        "Two-way link between {source} and {target}, {access}. {source} to {target}: {forward}. {target} to {source}: {back}",
        {
          source,
          target,
          access: m(accessConfig[edge.link.access].label),
          forward: healthLabel(edge.health, gt),
          back: healthLabel(back.health, gt),
        },
      );
}

/**
 * Says in place why a drop cannot be linked in one go, and offers what works: one machine at
 * a time, with a pairing code from it.
 */
function CodeOnlyNotice({
  graph,
  dropped,
  onLinkOne,
  onDismiss,
}: {
  readonly graph: FleetGraph;
  readonly dropped: CodeOnlyDrop;
  readonly onLinkOne: (sourceId: string, targetId: string) => void;
  readonly onDismiss: () => void;
}) {
  const gt = useGT();
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const source = byId.get(dropped.sourceId);
  const machines = dropped.machineIds.flatMap((id) => byId.get(id) ?? []);
  if (source === undefined || machines.length === 0) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/60 bg-background/50 px-3 py-2 text-meta"
    >
      <p className="min-w-0 flex-1 basis-64 text-muted-foreground">
        {needsCodeText(machines.length, gt)}
      </p>
      {/* Linking through an environment that already reaches these machines would be offered here. */}
      <Menu>
        <MenuTrigger
          render={
            <Button size="xs" variant="secondary">
              {gt("Link one with a code…")}
            </Button>
          }
        />
        <MenuPopup align="end">
          {machines.map((machine) => (
            <MenuItem key={machine.id} onClick={() => onLinkOne(dropped.sourceId, machine.id)}>
              {machine.label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <Button size="icon-xs" variant="ghost" aria-label={gt("Dismiss")} onClick={onDismiss}>
        <XIcon />
      </Button>
    </div>
  );
}

const needsCodeText = (count: number, gt: GT) =>
  gt(
    "{count, plural, one {# machine needs a pairing code} other {# machines each need a pairing code}}",
    { count },
  );

function actionText(action: FleetLinkAction | null, target: string, gt: GT): string {
  if (action === null) return gt("Cannot link to this");
  if (action.kind === "code-only") return needsCodeText(action.machineIds.length, gt);
  if (action.kind === "batch") {
    return gt("{count, plural, one {Link to # machine} other {Link to # machines}}", {
      count: action.environmentIds.length,
    });
  }
  const { offer } = action;
  if (offer === null) return gt("Cannot link to this");
  if (offer.path === "code-less") {
    return offer.renews
      ? gt("Renew link to {target}", { target })
      : gt("Link to {target}", { target });
  }
  if (offer.path === "through-link") {
    return offer.renews
      ? gt("Renew link to {target}", { target })
      : gt("Link to {target}", { target });
  }
  return offer.renews
    ? gt("Renew link to {target} with a pairing code", { target })
    : gt("Link to {target} with a pairing code", { target });
}

function foldGroupLabel(group: FleetFoldGroup, gt: GT): string {
  switch (group) {
    case "offline":
      return gt("Offline");
    case "off":
      return gt("Switched off", { $context: "environments the user has switched off in this app" });
    case "update":
      return gt("Need an update", {
        $context: "environments running a version this app cannot talk to",
      });
    case "not-added":
      return gt("Not added");
  }
}

const COLUMN_TITLES = (gt: GT): Record<FleetColumn, string> => ({
  client: gt("This app"),
  environments: gt("Environments"),
  targets: gt("Linked machines"),
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
  selected,
  matches,
  onSelect,
  onTick,
  onLink,
  onToggleStack,
  onReveal,
}: FleetSceneProps & {
  /** Machines a search names; the rest step back. Null when nothing is searched for. */
  readonly matches: ReadonlySet<string> | null;
  readonly onReveal: (rect: FleetRect) => void;
}) {
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
  const pairs = fleetTwoWayLinks(graph);
  const labelOf = (id: string) => nodeById.get(id)?.label ?? "";
  /** The other link of the two-way link `edge` is drawn for. */
  const backOf = (edge: FleetLinkEdge) => pairs.get(edge.id)?.back;
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
      dimmed && "opacity-25 forced-colors:opacity-40",
    );
  const routeLit = (edge: FleetRouteEdge) => lit === null || lit.edges.has(edge.id);
  // Painted last, so the routes in focus lie over the ones that are not.
  const routePaintOrder =
    lit === null ? routeEdges : routeEdges.toSorted((a, b) => +routeLit(a) - +routeLit(b));
  const linkLit = (edge: FleetLinkEdge) =>
    isSelected("edge", edge.id) || (lit?.edges.has(edge.id) ?? false);
  // Painted last, so the links in focus lie over the ones that are not.
  const paintOrder = lit === null ? links : links.toSorted((a, b) => +linkLit(a) - +linkLit(b));
  const dragAction = (targetId: string) =>
    linkDrag === null
      ? null
      : fleetLinkAction(graph, stacks, selected, linkDrag.sourceId, targetId);
  // A stack fades as a whole, by the links and machines it stands for.
  const nodeDimmed = (id: string) =>
    layout.stacks.has(id)
      ? false
      : linkDrag !== null
        ? id !== linkDrag.sourceId && dragAction(id) === null
        : (lit !== null && !lit.nodes.has(id)) || (matches !== null && !matches.has(id));
  // By the links it stands for: a host and a member can both be lit through other links.
  const stackLit = (stack: FleetStack) =>
    lit === null || stack.edgeIds.some((id) => lit.edges.has(id));
  const stackDimmed = (stack: FleetStack) =>
    linkDrag !== null
      ? false
      : !stackLit(stack) || (matches !== null && !stack.memberIds.some((id) => matches.has(id)));
  // A machine drawn on its own can be ticked for a batch link; the client and stacks cannot.
  const tickable = (id: string) => id !== FLEET_CLIENT_NODE_ID && layout.nodes.has(id);
  // A machine shown in the details but folded into a stack marks the stack it is in.
  const holdsSelection = (stack: FleetStack) =>
    selection?.kind === "node" &&
    !layout.nodes.has(selection.id) &&
    stack.memberIds.includes(selection.id);
  const hoverProps = (target: FleetFocus) => ({
    onPointerEnter: () => setHover(target),
    onPointerLeave: () => setHover(null),
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = ARROW_ROVE[event.key];
    const from = (event.target as HTMLElement).closest<HTMLElement>("[data-fleet-node]");
    if (event.key === "" && from !== null && tickable(from.dataset.fleetNode ?? "")) {
      // Space ticks the machine for a batch link; Enter still opens its details.
      event.preventDefault();
      if (!event.repeat) onTick([from.dataset.fleetNode ?? ""], "toggle");
      return;
    }
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
    "data-drop-over": linkDrag?.overId === target.id ? "" : undefined,
    "data-faded": nodeDimmed(target.id) ? "" : undefined,
    "aria-label": selected.has(target.id)
      ? gt("{label}, selected", { label, $context: "a machine ticked on a map" })
      : label,
    "aria-pressed": isSelected(target.kind, target.id),
    tabIndex: target.id === tabStop ? 0 : -1,
    style: { left: rect.x, top: rect.y, width: rect.width, height: rect.height },
    onClick: (event: MouseEvent<HTMLElement>) => {
      if ((event.shiftKey || event.metaKey || event.ctrlKey) && tickable(target.id)) {
        onTick([target.id], "toggle");
        return;
      }
      onSelect(isSelected(target.kind, target.id) ? null : target);
    },
    // The keydown ticked the machine; without this the button would also click.
    onKeyUp: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "" && tickable(target.id)) event.preventDefault();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      setRoving(target.id);
      setHover(target);
      // Tabbing back in can land on a machine panned out of view; a click cannot.
      if (event.currentTarget.matches(":focus-visible")) onReveal(rect);
    },
    onBlur: () => setHover(null),
    ...hoverProps(target),
  });

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
    return over !== undefined && fleetLinkAction(graph, stacks, selected, sourceId, over) !== null
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
  const dragOver = linkDrag?.overId ?? null;

  return (
    <div
      role="group"
      aria-label={gt("Map of your machines")}
      aria-description={gt(
        "Arrow keys move between machines. Enter opens a machine's details, with its routes and links. Space selects a machine for linking several at once. Tab from an environment reaches its link button. Plus and minus zoom, zero fits the map.",
      )}
      onKeyDown={onKeyDown}
    >
      {layout.columns.map((column) => (
        <p
          key={column.id}
          aria-hidden
          style={{ left: column.x }}
          className="absolute top-0 text-caption whitespace-nowrap text-muted-foreground"
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
        {routePaintOrder.map((edge) => {
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
              className={cn(style.wire, fadeLine(!routeLit(edge)))}
            />
          );
        })}
        {stacks.map((stack) => {
          const geometry = layout.stacks.get(stack.id);
          if (geometry === undefined) return null;
          const onPath = stackLit(stack);
          return geometry.lines.map((line) => {
            // A folded group of environments has one wire for all its routes, none in use.
            if (line.access === null) {
              return (
                <path
                  key={`${stack.id}:routes`}
                  d={line.d}
                  stroke="currentColor"
                  strokeWidth={ROUTE_STYLES.idle.width}
                  strokeDasharray={ROUTE_STYLES.idle.dash}
                  className={cn(ROUTE_STYLES.idle.wire, fadeLine(lit !== null && !onPath))}
                />
              );
            }
            const level = accessLevel(line.access);
            const mine = lit === null || lit.nodes.has(line.sourceId ?? "");
            return (
              <g
                key={`${stack.id}:${line.sourceId}`}
                className={cn("text-foreground", fadeLine(lit !== null && !(onPath && mine)))}
                opacity={lit !== null && onPath && mine ? 1 : ACCESS_STROKE_OPACITIES[level]}
              >
                <path d={line.d} stroke="currentColor" strokeWidth={ACCESS_STROKE_WIDTHS[level]} />
                {line.arrow === null ? null : (
                  <path
                    d={`M${line.arrow.x - 8} ${line.arrow.y - 4.5}L${line.arrow.x} ${line.arrow.y}L${line.arrow.x - 8} ${line.arrow.y + 4.5}Z`}
                    fill="currentColor"
                  />
                )}
              </g>
            );
          });
        })}
        {paintOrder.map((edge) => {
          const geometry = layout.links.get(edge.id);
          if (geometry === undefined) return null;
          const selected = isSelected("edge", edge.id);
          const level = accessLevel(edge.link.access);
          const back = backOf(edge);
          // A two-way link is drawn in halves, each leading into the machine its link reaches,
          // so a direction in trouble shows at its own end.
          const parts: ReadonlyArray<readonly [string, FleetArrow, PeerLinkHealth]> =
            geometry.twoWay !== null && back !== undefined
              ? [
                  [geometry.twoWay.forward, geometry.arrow, edge.health],
                  [geometry.twoWay.back, geometry.twoWay.backArrow, back.health],
                ]
              : [[geometry.d, geometry.arrow, edge.health]];
          return (
            <g
              key={edge.id}
              className={cn("pointer-events-none", fadeLine(lit !== null && !linkLit(edge)))}
              opacity={linkLit(edge) ? 1 : ACCESS_STROKE_OPACITIES[level]}
            >
              {parts.map(([d, arrow, health]) => (
                <g
                  key={d}
                  className={
                    selected
                      ? "text-primary"
                      : linkNeedsAttention(health)
                        ? healthTone(health)
                        : "text-foreground"
                  }
                >
                  <path
                    d={d}
                    stroke="currentColor"
                    // Selection also thickens the line, for when colour is forced.
                    strokeWidth={(ACCESS_STROKE_WIDTHS[level] ?? 2) + (selected ? 1 : 0)}
                    strokeDasharray={healthDash(health)}
                  />
                  <path
                    d={`M${arrow.x - arrow.dir * 7} ${arrow.y - 4}L${arrow.x} ${arrow.y}L${arrow.x - arrow.dir * 7} ${arrow.y + 4}Z`}
                    fill="currentColor"
                  />
                </g>
              ))}
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
              <title>{linkName(edge, backOf(edge), labelOf, gt, m)}</title>
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
        // The badge's tint sits on the map's own fill, so the wire running under it never shows.
        return (
          <span
            key={edge.id}
            aria-hidden
            style={{ left: pill.x, top: pill.y, width: pill.width, height: pill.height }}
            className={cn(
              "absolute flex rounded-badge bg-(--map-canvas-background)",
              // Lit routes sit over the others, whose wires pass beside them on the way in.
              routeLit(edge) && "z-1",
            )}
          >
            <Badge
              variant={routeLit(edge) ? ROUTE_STYLES[edge.state].badge : "quiet"}
              className="size-full min-w-0"
            >
              <span className="truncate">
                {edge.routeLabel ?? routeKindLabel(edge.routeKind, gt)}
              </span>
            </Badge>
          </span>
        );
      })}
      {links.map((edge) => {
        const badge = layout.links.get(edge.id)?.badge;
        if (!badge) return null;
        const target = { kind: "edge", id: edge.id } as const;
        const back = backOf(edge);
        const health = back === undefined ? edge.health : worseLinkHealth(edge.health, back.health);
        // With no clear place of its own, the name shows only while its link is the one in focus.
        if (
          badge.onDemand &&
          !isSelected("edge", edge.id) &&
          !(focus?.kind === "edge" && focus.id === edge.id)
        ) {
          return null;
        }
        return (
          <ContentButton
            variant="fleet-route-pill"
            key={edge.id}
            data-fleet-item=""
            data-on-demand={badge.onDemand ? "" : undefined}
            tabIndex={-1}
            aria-pressed={isSelected("edge", edge.id)}
            aria-label={linkName(edge, back, labelOf, gt, m)}
            // Hangs off its own lane and grows away from the lanes beside it.
            style={{
              top: badge.y,
              height: badge.height,
              maxWidth: badge.width,
              ...(badge.side === 1
                ? { left: badge.x }
                : { right: layout.width - badge.x - badge.width }),
            }}
            data-health={lit === null || lit.edges.has(edge.id) ? healthState(health) : undefined}
            data-faded={lit !== null && !lit.edges.has(edge.id) ? "" : undefined}
            className="absolute"
            onClick={() => onSelect(isSelected("edge", edge.id) ? null : target)}
            onFocus={() => setHover(target)}
            onBlur={() => setHover(null)}
            {...hoverProps(target)}
          >
            {back === undefined ? null : (
              <ArrowUpDownIcon aria-hidden className="size-3 shrink-0" />
            )}
            <AccessMeter
              access={edge.link.access}
              className={cn(lit !== null && !lit.edges.has(edge.id) && "opacity-45")}
            />
            <span className="truncate">{m(accessConfig[edge.link.access].label)}</span>
          </ContentButton>
        );
      })}
      {stacks.map((stack) => {
        const geometry = layout.stacks.get(stack.id);
        if (geometry === undefined) return null;
        const { face, tray, more } = geometry;
        const count = stack.memberIds.length;
        const range =
          stack.firstLabel === stack.lastLabel
            ? stack.firstLabel
            : `${stack.firstLabel} … ${stack.lastLabel}`;
        const group = stack.group === null ? null : foldGroupLabel(stack.group, gt);
        const [only] = stack.sources;
        const summary =
          group !== null
            ? range
            : stack.sources.length === 1 && only !== undefined
              ? gt("{access}. {reachable} of {count} reachable", {
                  access: m(accessConfig[only.access].label),
                  reachable: stack.reachable,
                  count,
                })
              : gt("{reachable} of {count} reachable, from {sources} environments", {
                  reachable: stack.reachable,
                  count,
                  sources: stack.sources.length,
                });
        const spoken =
          group !== null
            ? gt("{group}: {count} environments with no links, {range}", { group, count, range })
            : gt("{range}, {count} machines linked from {sources}. {summary}", {
                range,
                count,
                sources: stack.sources
                  .map((source) => nodeById.get(source.sourceId)?.label ?? "")
                  .join(","),
                summary,
              });
        const partial = fleetStackPartial(stack);
        // The room the card adds below its name when some machines do not answer.
        const partialBand = partial ? 20 : 0;
        const ToggleIcon = stack.expanded ? FoldVerticalIcon : UnfoldVerticalIcon;
        const hidden = count - stack.shownIds.length;
        return (
          <div key={stack.id} className={fade(stackDimmed(stack))}>
            {/* The card is the same open or closed, so it does not change under the pointer. */}
            {[8, 4].map((lift) => (
              <div
                key={lift}
                aria-hidden
                style={{
                  left: face.x + lift,
                  top: face.y - lift,
                  width: face.width,
                  height: face.height,
                }}
                className={cn(
                  "absolute rounded-lg border border-border surface-card-settings transition-opacity duration-200 ease-out motion-reduce:transition-none",
                  group !== null && "border-dashed",
                  stack.expanded && "opacity-0",
                )}
              />
            ))}
            {tray === null ? null : (
              <div
                aria-hidden
                style={{ left: tray.x, top: tray.y, width: tray.width, height: tray.height }}
                className={cn(
                  "absolute rounded-xl border border-border/70 bg-foreground/3",
                  APPEAR,
                )}
              />
            )}
            <ContentButton
              variant="fleet-stack"
              {...focusProps({ kind: "stack", id: stack.id }, face, spoken)}
              data-partial={partialBand > 0 ? "" : undefined}
              data-grouped={group !== null ? "" : undefined}
              data-holds-selection={holdsSelection(stack) ? "" : undefined}
              className="absolute"
            >
              <span className="flex min-h-0 min-w-0 flex-1 flex-col justify-center px-2.5 pr-8">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-meta leading-4 text-foreground">
                    {group ?? range}
                  </span>
                  {group === null ? null : (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 text-caption leading-4 text-muted-foreground tabular-nums forced-colors:border">
                      {count}
                    </span>
                  )}
                </span>
                {group !== null ? (
                  <span className="block truncate text-caption leading-4 text-muted-foreground">
                    {range}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-caption leading-4 text-muted-foreground">
                    {only !== undefined && stack.sources.length === 1 ? (
                      <AccessMeter access={only.access} className="text-foreground/70" />
                    ) : null}
                    <span className="whitespace-nowrap tabular-nums">
                      {gt("{machines, plural, one {# machine} other {# machines}}", {
                        machines: count,
                      })}
                    </span>
                  </span>
                )}
              </span>
              {partialBand === 0 ? null : (
                // The headline of a stack that is partly down: its own band, never cut short.
                <span
                  style={{ height: partialBand }}
                  className="flex shrink-0 items-center gap-1.5 border-t border-warning/30 bg-warning/16 px-2.5 text-caption leading-none text-warning-foreground forced-colors:border-t-2"
                >
                  <TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-warning" />
                  <span className="shrink-0 whitespace-nowrap tabular-nums">
                    {gt("{reachable, plural, =0 {None reachable} other {# reachable}}", {
                      reachable: stack.reachable,
                      $context:
                        "on a card for a group of linked machines: how many of them answer right now",
                    })}
                  </span>
                  <span className="h-1 min-w-0 flex-1 overflow-clip rounded-full bg-warning/25 forced-colors:hidden">
                    <span
                      className="block h-full rounded-full bg-warning"
                      style={{ width: `${(stack.reachable / count) * 100}%` }}
                    />
                  </span>
                </span>
              )}
            </ContentButton>
            <ContentButton
              variant="fleet-toggle"
              data-fleet-item=""
              tabIndex={stack.id === tabStop ? 0 : -1}
              aria-label={
                stack.expanded
                  ? gt("Collapse these machines")
                  : hidden > 0
                    ? gt("Show the first {shown} machines on the map", {
                        shown: stack.shownIds.length,
                      })
                    : gt("Show each machine on the map")
              }
              aria-expanded={stack.expanded}
              style={{
                left: face.x + face.width - 28,
                top: face.y + (face.height - partialBand) / 2 - 11,
              }}
              className="absolute"
              onClick={() => onToggleStack(stack.id)}
            >
              <ToggleIcon aria-hidden className="size-3.5" />
            </ContentButton>
            {more === null ? null : (
              // The rest are never drawn: the details list every machine, and can be searched.
              <ContentButton
                variant="fleet-more"
                data-fleet-item=""
                data-fleet-node={fleetMoreNodeId(stack.id)}
                tabIndex={fleetMoreNodeId(stack.id) === tabStop ? 0 : -1}
                style={{ left: more.x, top: more.y, width: more.width, height: more.height }}
                data-appear=""
                className="absolute"
                onClick={() => onSelect({ kind: "stack", id: stack.id })}
                onFocus={() => setRoving(fleetMoreNodeId(stack.id))}
              >
                <span className="truncate">
                  {gt("and {count} more", {
                    count: hidden,
                    $context: "a card standing for the machines of a group that are not drawn",
                  })}
                </span>
              </ContentButton>
            )}
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
            <ContentButton
              variant="fleet-client"
              key={node.id}
              {...focusProps(target, rect, node.label)}
              className="absolute"
            >
              <ClientIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-meta">{node.label}</span>
            </ContentButton>
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
            <ContentButton
              variant="fleet-target"
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
                ].join(","),
              )}
              data-compact={compact ? "" : undefined}
              data-appear={compact ? "" : undefined}
              data-health={first ? healthState(first.health) : undefined}
              className="absolute"
            >
              <span className="flex w-3 shrink-0 justify-center">
                {first ? <HealthGlyph health={first.health} /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate",
                    compact ? "text-caption leading-none" : "text-meta leading-4",
                  )}
                >
                  {node.label}
                </span>
                {compact || !first ? null : (
                  <span
                    className={cn(
                      "block truncate text-caption leading-4",
                      first.health.kind === "reachable" && first.health.expiresInDays === null
                        ? "text-muted-foreground"
                        : healthTone(first.health),
                    )}
                  >
                    {shown === undefined ? (
                      gt("{count, plural, one {# link in} other {# links in}}", {
                        count: incoming.length,
                        $context:
                          "how many machines hold a link to this machine; pairs with '# links out'",
                      })
                    ) : first.health.kind === "reachable" && first.health.expiresInDays === null ? (
                      m(accessConfig[first.link.access].label)
                    ) : (
                      <>
                        {m(accessConfig[first.link.access].label)}
                        <span className="ms-1.5">{healthLabel(first.health, gt)}</span>
                      </>
                    )}
                  </span>
                )}
              </span>
              {compact || !shown ? null : (
                <AccessMeter access={shown.link.access} className="text-foreground/70" />
              )}
            </ContentButton>
          );
        }
        if (rect.height < 32) {
          // Inside an open group of environments: its name and state; the details have the rest.
          const state =
            node.kind === "connect"
              ? connectAvailabilityText(node.availability, gt)
              : connectionStateText(node, environmentById.get(node.id), false, gt);
          return (
            <ContentButton
              variant="fleet-available"
              key={node.id}
              {...focusProps(target, rect, `${node.label}, ${state}`)}
              data-appear=""
              className="absolute"
            >
              <StatusDot
                size="md"
                tone={
                  node.kind === "environment" && node.enabled
                    ? connectionPhaseTone(node.phase)
                    : "neutral"
                }
              />
              <span className="truncate text-caption leading-none">{node.label}</span>
            </ContentButton>
          );
        }
        if (node.kind === "connect") {
          const status = (
            <>
              {gt("Not added")}
              <span className="ms-1.5">{connectAvailabilityText(node.availability, gt)}</span>
            </>
          );
          return (
            <ContentButton
              variant="fleet-account"
              key={node.id}
              {...focusProps(
                target,
                rect,
                gt("{label}, on your T3 Connect account, not added to this app. {status}", {
                  label: node.label,
                  status: connectAvailabilityText(node.availability, gt),
                }),
              )}
              className="absolute"
            >
              <CloudIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-meta leading-4 text-foreground">
                  {node.label}
                </span>
                <span className="block truncate text-caption leading-4 text-muted-foreground">
                  {status}
                </span>
              </span>
            </ContentButton>
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
            <ContentButton
              variant="fleet-this"
              {...focusProps(
                target,
                rect,
                [
                  node.label,
                  spoken,
                  ...routes.map(
                    (edge) =>
                      `${edge.routeLabel ?? routeKindLabel(edge.routeKind, gt)}: ${routeStateLabel(edge.state, gt)}`,
                  ),
                ].join(","),
              )}
              data-dimmed={dimmed ? "" : undefined}
              data-over={over ? "" : undefined}
              className="absolute"
            >
              <span
                className={cn(
                  "relative flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-foreground/80 forced-colors:border",
                  dimmed && "opacity-60",
                )}
              >
                <EnvironmentMachineIcon kind={node.machine ?? "server"} className="size-3.5" />
                <span className="absolute -right-1 -bottom-1 flex rounded-full border-2 border-card">
                  <StatusDot tone={node.enabled ? connectionPhaseTone(node.phase) : "neutral"} />
                </span>
              </span>
              <span className={cn("min-w-0 flex-1 pr-1.5", dimmed && "opacity-70")}>
                <span className="line-clamp-2 text-meta leading-4 [overflow-wrap:anywhere]">
                  {node.label}
                </span>
                <span
                  className={cn(
                    "block truncate text-caption leading-4",
                    node.outgoing === "error" && node.phase === "connected"
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {status}
                </span>
              </span>
            </ContentButton>
            {handle !== undefined && node.linking === "ready" ? (
              <span
                style={{ left: handle.x - HANDLE / 2, top: handle.y - HANDLE / 2 }}
                className={cn("absolute flex", fade(nodeDimmed(node.id)))}
              >
                <Button
                  size="icon-xs-pill"
                  variant="secondary"
                  data-fleet-item=""
                  tabIndex={node.id === tabStop ? 0 : -1}
                  aria-label={gt("Link {label} to another machine", { label: node.label })}
                  onFocus={(event) => {
                    // Its own bounds: it straddles the card's edge, so the card can be in view
                    // while half the handle is not.
                    if (event.currentTarget.matches(":focus-visible")) {
                      onReveal({
                        x: handle.x - HANDLE / 2,
                        y: handle.y - HANDLE / 2,
                        width: HANDLE,
                        height: HANDLE,
                      });
                    }
                  }}
                  {...handleProps(node.id)}
                >
                  <PlusIcon aria-hidden />
                </Button>
              </span>
            ) : null}
          </div>
        );
      })}
      {[...selected].map((id) => {
        const rect = layout.nodes.get(id);
        if (rect === undefined) return null;
        return (
          <span
            key={id}
            aria-hidden
            style={{
              left: rect.x - 3,
              top: rect.y - 3,
              width: rect.width + 6,
              height: rect.height + 6,
            }}
            className="pointer-events-none absolute rounded-xl border-2 border-primary bg-primary/6"
          >
            <span className="absolute -top-2 -left-2 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground forced-colors:border">
              <CheckIcon className="size-2.5" strokeWidth={3} />
            </span>
          </span>
        );
      })}
      {linkDrag !== null ? (
        <DragHint x={linkDrag.x} y={linkDrag.y}>
          {dragOver !== null
            ? actionText(dragAction(dragOver), nodeById.get(dragOver)?.label ?? "", gt)
            : gt("Drop on a machine to link")}
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
      className="pointer-events-none absolute z-10 rounded-md border border-border bg-popover px-2 py-1 text-caption whitespace-nowrap text-popover-foreground shadow-sm/5"
    >
      {children}
    </p>
  );
}
