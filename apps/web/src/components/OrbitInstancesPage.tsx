import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  filterOrbitInstances,
  groupOrbitInstances,
  joinOrbitInstanceThreads,
  orbitCompletionPhase,
  orbitInstanceAvailability,
  orbitInstanceProjectOptions,
  type OrbitInstanceState,
  type OrbitInstanceWithThreads,
} from "@t3tools/client-runtime/orbit-gateway";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MessageSquareIcon,
  SearchIcon,
  SquarePenIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { deriveProjectIdentity } from "@t3tools/shared/projectIdentity";
import {
  ORBIT_INSTANCE_GIT_READ_WAIT_MS,
  orbitInstanceRemoveAcknowledgesGit,
  readOrbitInstanceGit,
  type OrbitInstanceGitState,
} from "@t3tools/client-runtime/orbit-gateway";
import { useRef, useState } from "react";

import { cn } from "../lib/utils";
import { openOrbitInstanceById } from "../orbit/openOrbitInstance";
import { loadOrbitInstanceList } from "../orbit/orbitInstanceList";
import { orbitWakeSupported, useOrbitInstanceSleep } from "../orbit/orbitInstanceSleep";
import {
  runOrbitInstanceRemoval,
  useOrbitInstanceListWithRemovals,
  webOrbitInstanceRemovalPorts,
  type OrbitInstanceRemoval,
} from "../orbit/orbitInstanceRemoval";
import { desktopOrbitGatewayClient } from "../orbit/OrbitProfileSync";
import { readStored as readStoredOrbitStarts } from "../orbit/orbitThreadStartStore";
import { readAttachedServersFlag } from "../orbit/attachedServersSeed";
import { orbitListThreadInputs, useOrbitThreadIndexStore } from "../orbit/orbitThreadIndex";
import { useVisibleThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  OrbitInstanceRemoveAction,
  OrbitInstanceRemoveDialog,
  OrbitInstanceRemoveFailure,
  orbitInstanceRemovingText,
} from "./OrbitInstanceRemove";
import { ProjectMonogram } from "./ProjectMonogram";

/** Whether this device follows a setup (`instance.complete`) of the Instance that still runs. */
function completionRunning(instanceId: number): boolean {
  return readStoredOrbitStarts().some(
    (start) => start.instanceId === instanceId && orbitCompletionPhase(start) === "running",
  );
}
import { isSidebarHiddenThread } from "./Sidebar.logic";
import { SettingsPageContainer, SettingsSection } from "./settings/settingsLayout";
import { Button } from "./ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { Skeleton } from "./ui/skeleton";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The palette's dot: green running, yellow stopped, grey hollow when no thread can reach it. */
function InstanceDot({ state }: { readonly state: OrbitInstanceState }) {
  return (
    <span className="flex h-5 w-2 shrink-0 items-center" aria-hidden data-instance-dot={state}>
      <span
        className={cn(
          "size-2 rounded-full",
          state === "running"
            ? "bg-success"
            : state === "stopped"
              ? "bg-warning"
              : "border border-muted-foreground/70",
        )}
      />
    </span>
  );
}

/** `<node> · <domain> · <state> · N threads · used …`. */
function instanceFacts(row: OrbitInstanceWithThreads): string {
  const { label } = orbitInstanceAvailability(row);
  const count = row.threads.length;
  return [
    row.nodeName,
    row.domain,
    label,
    count === 0 ? "no threads" : plural(count, "thread"),
    row.lastUsedAt === null ? null : `used ${formatRelativeTimeLabel(row.lastUsedAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The domain without the Instance name, such as `.nckrtl.test`, for the Orbit draft. */
function domainSuffix(row: OrbitInstanceWithThreads): string | null {
  const prefix = `${row.name}.`;
  return row.domain?.startsWith(prefix) ? row.domain.slice(row.name.length) : null;
}

function NewThreadButton({ row }: { readonly row: OrbitInstanceWithThreads }) {
  const router = useRouter();
  const canWake = useOrbitInstanceSleep((state) => orbitWakeSupported(state.unsupportedAt));
  const { blockedReason } = orbitInstanceAvailability(row, canWake);
  const [opening, setOpening] = useState(false);
  const open = async () => {
    setOpening(true);
    const result = await openOrbitInstanceById({
      router,
      project: {
        id: row.projectId,
        slug: row.projectSlug,
        name: row.projectName,
        nodeName: row.nodeName,
        domainSuffix: domainSuffix(row),
      },
      instance: { id: row.id, name: row.name },
      // A fresh read, as the palette's own on open: its cached list can miss this row's state.
      environments: () => {
        const client = desktopOrbitGatewayClient();
        if (client === null) throw new Error("The Orbit Gateway is not available here.");
        return client.environments();
      },
    }).catch((error: unknown) => ({
      kind: "unavailable" as const,
      reason: error instanceof Error ? error.message : String(error),
    }));
    setOpening(false);
    if (result.kind === "unavailable") {
      toastManager.add({
        type: "error",
        title: `Could not open Instance ${row.name}`,
        description: result.reason,
      });
    }
  };
  // Blocked stays focusable (aria-disabled, not disabled) so keyboard focus opens the reason.
  const blocked = blockedReason !== null;
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="New thread in this Instance"
            aria-description={blockedReason ?? undefined}
            aria-disabled={blocked || undefined}
            disabled={!blocked && opening}
            onClick={() => {
              if (!blocked) void open();
            }}
          />
        }
      >
        {opening ? <Spinner /> : <SquarePenIcon />}
      </TooltipTrigger>
      <TooltipPopup side="top">{blockedReason ?? "New thread in this Instance"}</TooltipPopup>
    </Tooltip>
  );
}

function ProjectBadge({ name }: { readonly name: string }) {
  const identity = deriveProjectIdentity(name);
  return <ProjectMonogram text={identity.monogram} color={identity.color} className="size-5" />;
}

function InstanceThreads({ row }: { readonly row: OrbitInstanceWithThreads }) {
  const navigate = useNavigate();
  return (
    <ul
      className="mt-2 ms-5 divide-y divide-border/70 overflow-hidden rounded-md border border-border/70 bg-muted/30"
      aria-label={`Threads in ${row.name}`}
    >
      {row.threads.map((thread) => (
        <li key={thread.id}>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-start text-ui hover:bg-accent"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(
                  scopeThreadRef(
                    EnvironmentId.make(thread.environmentId),
                    ThreadId.make(thread.id),
                  ),
                ),
              })
            }
          >
            {thread.working ? (
              <Spinner className="size-3.5 shrink-0" />
            ) : (
              <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate">{thread.title}</span>
            <span className="shrink-0 text-muted-foreground text-xs">
              {thread.working ? "Working" : formatRelativeTimeLabel(thread.updatedAt)}
            </span>
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The row the remove dialog asks about, with the Git state Orbit named (the read when the dialog
 * opened, or its refusal at the click). `checking`: the read runs and Remove Instance waits.
 */
interface RemoveRequest {
  readonly row: OrbitInstanceWithThreads;
  readonly git: OrbitInstanceGitState | undefined;
  readonly checking?: boolean;
  readonly opened?: symbol;
}

/**
 * The remove dialog's request. Opening it asks Orbit for the Instance's Git state at once, so the
 * dialog shows the truth before the click. Remove Instance waits for the answer at most
 * `ORBIT_INSTANCE_GIT_READ_WAIT_MS`; after that, or without an answer (an older Gateway), the
 * dialog works as before. A later answer still updates the dialog until the click.
 */
function useRemoveRequest() {
  const [request, setRequestState] = useState<RemoveRequest | null>(null);
  // The newest request, also before React renders it: a click checks it (`confirmable`).
  const latest = useRef<RemoveRequest | null>(null);
  const setRequest = (next: RemoveRequest | null) => {
    latest.current = next;
    setRequestState(next);
  };
  const open = (row: OrbitInstanceWithThreads) => {
    const opened = Symbol(String(row.id));
    const update = (change: (current: RemoveRequest) => RemoveRequest) => {
      const current = latest.current;
      if (current?.opened === opened) setRequest(change(current));
    };
    const client = desktopOrbitGatewayClient();
    setRequest({ row, git: row.git, checking: client !== null, opened });
    if (client === null) return;
    const wait = setTimeout(
      () => update((current) => ({ ...current, checking: false })),
      ORBIT_INSTANCE_GIT_READ_WAIT_MS,
    );
    void readOrbitInstanceGit(client, row.id).then((git) => {
      clearTimeout(wait);
      update((current) => ({ ...current, checking: false, git: git ?? current.git }));
    });
  };
  /**
   * What a click on Remove Instance may do. The dialog showed the newest Git state: as clicked.
   * A late answer changed it in the same moment: a state that needs the tick drops the click; one
   * that does not removes without the override, so Orbit still reads the Instance itself.
   */
  const confirmable = (
    shownGit: OrbitInstanceGitState | undefined,
    acknowledgeUnsaved: boolean,
  ): { readonly request: RemoveRequest; readonly acknowledgeUnsaved: boolean } | null => {
    const current = latest.current;
    if (current === null || current.checking) return null;
    if (current.git === shownGit) return { request: current, acknowledgeUnsaved };
    return orbitInstanceRemoveAcknowledgesGit(current.git)
      ? null
      : { request: current, acknowledgeUnsaved: false };
  };
  return [request, setRequest, open, confirmable] as const;
}

async function removeInstance(
  row: OrbitInstanceWithThreads,
  git: OrbitInstanceGitState | undefined,
  acknowledgeUnsaved: boolean,
  askAgain: (request: RemoveRequest) => void,
) {
  const outcome = await runOrbitInstanceRemoval(
    { ...row, ...(git ? { git } : {}) },
    acknowledgeUnsaved,
    webOrbitInstanceRemovalPorts(),
  );
  if (outcome.kind === "unsaved_work") askAgain({ row, git: outcome.git });
}

function InstanceRow({
  row,
  listed,
  removal,
  onRemove,
  onRetry,
}: {
  readonly row: OrbitInstanceWithThreads;
  readonly removal: OrbitInstanceRemoval | undefined;
  /** False for a row kept from a saved removal after the Instance left Orbit's list. */
  readonly listed: boolean;
  readonly onRemove: () => void;
  readonly onRetry: (acknowledgeUnsaved: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const { state } = orbitInstanceAvailability(row);
  const hasThreads = row.threads.length > 0;
  const unfolded = open && hasThreads;
  const name = (
    <span className="flex min-h-5 min-w-0 items-center gap-2.5">
      <span className="truncate font-medium text-foreground text-sm">{row.name}</span>
      {row.workingCount > 0 ? (
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
          <Spinner className="size-3" />
          {row.workingCount === 1 ? "1 thread working" : `${row.workingCount} threads working`}
        </span>
      ) : null}
      {hasThreads ? (
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 shrink-0 text-muted-foreground", unfolded && "rotate-90")}
        />
      ) : null}
    </span>
  );
  const removing = removal?.status === "removing";
  const body = (
    <>
      {name}
      <span className="block truncate text-muted-foreground text-xs">
        {(removing
          ? orbitInstanceRemovingText(removal.progress, completionRunning(row.id))
          : null) ?? instanceFacts(row)}
      </span>
    </>
  );
  return (
    <div
      role="group"
      aria-label={row.name}
      className="px-3 py-3 sm:px-4"
      data-orbit-instance={row.id}
    >
      <div className="flex items-start gap-3">
        <InstanceDot state={state} />
        {hasThreads ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-col gap-0.5 text-start"
            aria-expanded={unfolded}
            onClick={() => setOpen((value) => !value)}
          >
            {body}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">{body}</div>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          {removing || !listed ? null : <NewThreadButton row={row} />}
          {/* On every row: the list cannot tell a checkout from a container; Orbit's refusal says so. */}
          <OrbitInstanceRemoveAction removing={removing} onRemove={onRemove} />
        </div>
      </div>
      {removal?.status === "failed" ? (
        <div className="mt-1.5 ms-5">
          <OrbitInstanceRemoveFailure
            refused={removal.refused}
            message={removal.message}
            onRetry={() => onRetry(removal.acknowledgeUnsaved)}
          />
        </div>
      ) : null}
      {unfolded ? <InstanceThreads row={row} /> : null}
    </div>
  );
}

const SKELETON_WIDTHS = ["46%", "38%", "52%", "34%"];

function LoadingRows() {
  return (
    <SettingsSection title="Loading instances" hideTitle>
      {SKELETON_WIDTHS.map((width) => (
        <div
          key={width}
          className="flex items-start gap-3 px-3 py-3 sm:px-4"
          data-orbit-instance-skeleton
        >
          <Skeleton className="mt-1.5 size-2" />
          <span className="flex flex-1 flex-col gap-1.5 py-0.5">
            <Skeleton className="h-3" style={{ width }} />
            <Skeleton className="h-2.5" style={{ width: `calc(${width} + 20%)` }} />
          </span>
        </div>
      ))}
    </SettingsSection>
  );
}

/** The palette's Gateway notice, with Retry. */
function GatewayNotice() {
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-muted-foreground text-sm sm:px-4"
      role="alert"
    >
      <TriangleAlertIcon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">Instances are not shown: the Gateway did not answer.</span>
      <Button size="xs" variant="outline" onClick={() => void loadOrbitInstanceList()}>
        Retry
      </Button>
    </div>
  );
}

function ProjectFilter(props: {
  readonly options: ReturnType<typeof orbitInstanceProjectOptions>;
  readonly projectId: number | null;
  readonly onChange: (projectId: number | null) => void;
}) {
  const picked = props.options.find((option) => option.projectId === props.projectId) ?? null;
  const check = (on: boolean) => (
    <CheckIcon className={cn("size-3.5", !on && "invisible")} aria-hidden />
  );
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="outline" size="sm" className="min-w-36 justify-between" />}
        aria-label="Project filter"
      >
        <span className="truncate">{picked?.projectName ?? "All projects"}</span>
        <ChevronDownIcon aria-hidden className="opacity-70" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-52">
        <MenuItem onClick={() => props.onChange(null)}>
          {check(picked === null)}
          All projects
        </MenuItem>
        <MenuSeparator />
        {props.options.map((option) => (
          <MenuItem key={option.projectId} onClick={() => props.onChange(option.projectId)}>
            {check(option.projectId === picked?.projectId)}
            <span className="min-w-0 flex-1 truncate">{option.projectName}</span>
            <span className="ms-4 text-muted-foreground text-xs tabular-nums">{option.count}</span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/**
 * Conn: the Orbit panel's Instances page (FORK.md, "Orbit panel"): every Instance this device can
 * reach, by Project, with its local threads.
 */
export function OrbitInstancesPage() {
  const { list, removals } = useOrbitInstanceListWithRemovals();
  const threads = useVisibleThreadShells();
  const threadIndex = useOrbitThreadIndexStore((store) => store.index);
  const heldEnvironments = useOrbitThreadIndexStore((store) => store.held);
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState<number | null>(null);
  const [removeRequest, setRemoveRequest, openRemoveRequest, confirmableRemoveRequest] =
    useRemoveRequest();
  const listedIds = new Set(list.status === "loaded" ? list.rows.map((row) => row.id) : []);

  const rows =
    list.status === "loaded"
      ? joinOrbitInstanceThreads(
          [
            ...list.rows.filter((row) => removals[row.id]?.status !== "removed"),
            // A removal still running or failed stays visible after its Instance left the list.
            ...Object.values(removals).flatMap((removal) =>
              removal.status !== "removed" && !listedIds.has(removal.row.id) ? [removal.row] : [],
            ),
          ],
          // Conn (C3, flag `connAttachedServers`): a held-off server's threads from the index.
          orbitListThreadInputs(
            threads
              .filter((thread) => !isSidebarHiddenThread(thread))
              .map((thread) => ({
                environmentId: thread.environmentId,
                id: thread.id,
                title: thread.title,
                updatedAt: thread.updatedAt,
                archivedAt: thread.archivedAt,
                working: threadRuntimeIsActive(thread.runtime),
              })),
            { index: threadIndex, held: heldEnvironments },
            readAttachedServersFlag(),
          ),
        )
      : [];
  const options = orbitInstanceProjectOptions(rows);
  // A filter on a Project that lost its last Instance shows every Project again.
  const filterProjectId = options.some((option) => option.projectId === projectId)
    ? projectId
    : null;
  const groups = groupOrbitInstances(
    filterOrbitInstances(rows, { query, projectId: filterProjectId }),
  );

  return (
    <SettingsPageContainer width="wide">
      <header className="space-y-1 px-3 sm:px-4">
        <h1 className="font-semibold text-foreground text-xl">Instances</h1>
        <p className="max-w-xl text-muted-foreground text-xs leading-relaxed">
          Every Orbit Instance this device can reach
          {list.status === "loaded" && rows.length > 0
            ? `: ${rows.length} in ${plural(options.length, "project")}`
            : ""}
          . Default Instances are not listed.
        </p>
      </header>
      <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4">
        <InputGroup className="min-w-48 flex-1">
          <InputGroupAddon>
            <SearchIcon aria-hidden className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Search instances"
            placeholder="Search instances"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </InputGroup>
        <ProjectFilter options={options} projectId={filterProjectId} onChange={setProjectId} />
      </div>
      {list.status === "loading" ? (
        <LoadingRows />
      ) : list.status === "unreachable" ? (
        <GatewayNotice />
      ) : rows.length === 0 ? (
        <div className="space-y-1 px-3 text-sm sm:px-4">
          <p className="text-foreground">No instances yet.</p>
          <p className="text-muted-foreground">
            To make one, choose New thread, then an Orbit Project.
          </p>
        </div>
      ) : groups.length === 0 ? (
        <p className="px-3 text-muted-foreground text-sm sm:px-4">Nothing found.</p>
      ) : (
        groups.map((group) => (
          <SettingsSection
            key={group.projectId}
            title={group.projectName}
            icon={<ProjectBadge name={group.projectName} />}
            titleAction={
              <span className="ms-1 text-muted-foreground text-xs tabular-nums">
                {group.rows.length}
              </span>
            }
          >
            {group.rows.map((row) => (
              <InstanceRow
                key={row.id}
                row={row}
                listed={listedIds.has(row.id)}
                removal={removals[row.id]}
                onRemove={() => openRemoveRequest(row)}
                onRetry={(acknowledgeUnsaved) =>
                  void removeInstance(row, row.git, acknowledgeUnsaved, setRemoveRequest)
                }
              />
            ))}
          </SettingsSection>
        ))
      )}
      <OrbitInstanceRemoveDialog
        target={
          removeRequest === null
            ? null
            : {
                name: removeRequest.row.name,
                domain: removeRequest.row.domain,
                nodeName: removeRequest.row.nodeName,
                threadCount: removeRequest.row.threads.length,
                workingCount: removeRequest.row.workingCount,
                git: removeRequest.git,
              }
        }
        checking={removeRequest?.checking === true}
        onCancel={() => setRemoveRequest(null)}
        onConfirm={(acknowledgeUnsaved, shownGit) => {
          const click = confirmableRemoveRequest(shownGit, acknowledgeUnsaved);
          if (click === null) return;
          setRemoveRequest(null);
          void removeInstance(
            click.request.row,
            click.request.git,
            click.acknowledgeUnsaved,
            setRemoveRequest,
          );
        }}
      />
    </SettingsPageContainer>
  );
}
