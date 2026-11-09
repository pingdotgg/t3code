import { useRouter } from "@tanstack/react-router";
import type {
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import { EllipsisIcon, PinIcon, PlusIcon } from "lucide-react";
import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useSidebarProjectGroups } from "~/hooks/useSidebarProjectGroups";
import { buildSidebarProjectPickerEntries } from "~/sidebarProjectGrouping";
import {
  useHiddenThreadKeys,
  useQuietThreadShells,
  useThreadShellsForProjectRefs,
} from "~/state/entities";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "~/state/olderSettledShelf";
import { textDirection } from "~/textDirection";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useClientSettings } from "../../hooks/useSettings";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSearchInput,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { buildThreadSwitcherThreads, resolveProjectSwitchTarget } from "./breadcrumbSwitcher.logic";

const PROJECT_ROW_CAP = 50;
const THREAD_ROW_CAP = 50;

function olderSettledScopes(refs: ReadonlyArray<ScopedProjectRef>): OlderSettledScope[] {
  const byEnvironment = new Map<EnvironmentId, ProjectId[]>();
  for (const ref of refs) {
    byEnvironment.set(ref.environmentId, [
      ...(byEnvironment.get(ref.environmentId) ?? []),
      ref.projectId,
    ]);
  }
  return [...byEnvironment].map(([environmentId, projectIds]) => ({ environmentId, projectIds }));
}

export function ProjectSwitcher(props: {
  readonly activeProject: EnvironmentProject;
  readonly trigger: ReactElement;
  readonly children: ReactNode;
  readonly onNewThreadInProject: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger render={props.trigger}>{props.children}</MenuTrigger>
      <MenuPopup align="start" className="w-72">
        <ProjectSwitcherContent
          activeProject={props.activeProject}
          onNewThreadInProject={props.onNewThreadInProject}
          onOpenChange={setOpen}
        />
      </MenuPopup>
    </Menu>
  );
}

function ProjectSwitcherContent(props: {
  readonly activeProject: EnvironmentProject;
  readonly onNewThreadInProject: () => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const groups = useSidebarProjectGroups();
  const threads = useQuietThreadShells();
  const hiddenThreadKeys = useHiddenThreadKeys();
  const sortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const router = useRouter();
  const newThread = useNewThreadHandler();
  const activeProjectRef = scopeProjectRef(
    props.activeProject.environmentId,
    props.activeProject.id,
  );
  const activeGroupKey =
    groups.find((group) =>
      group.memberProjectRefs.some(
        (ref) => scopedProjectKey(ref) === scopedProjectKey(activeProjectRef),
      ),
    )?.projectKey ?? "";
  const entries = buildSidebarProjectPickerEntries({
    groups: pickableProjectGroups(groups).filter((group) => !group.isScratch),
    preferredProjectRef: activeProjectRef,
  });
  const normalizedQuery = query.toLowerCase();
  const visible = entries
    .filter(({ group }) => group.displayName.toLowerCase().includes(normalizedQuery))
    .slice(0, PROJECT_ROW_CAP);
  const activeProjectName = props.activeProject.isScratch
    ? "No project"
    : props.activeProject.title;
  return (
    <>
      <MenuSearchInput
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="Search projects"
        aria-label="Search projects"
      />
      {query === "" ? (
        <>
          <MenuItem
            onClick={() => {
              props.onOpenChange(false);
              props.onNewThreadInProject();
            }}
          >
            <PlusIcon aria-hidden />
            New thread in {activeProjectName}
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      <MenuRadioGroup
        value={activeGroupKey}
        onValueChange={(value) => {
          props.onOpenChange(false);
          if (value === activeGroupKey) return;
          const entry = entries.find(({ group }) => group.projectKey === value);
          if (!entry) return;
          const target = resolveProjectSwitchTarget({
            threads,
            projectRefs: entry.group.memberProjectRefs,
            targetProject: scopeProjectRef(
              entry.targetProject.environmentId,
              entry.targetProject.id,
            ),
            hiddenThreadKeys,
            sortOrder,
          });
          if (target.kind === "thread") {
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(target.threadRef),
            });
          } else {
            void newThread(target.projectRef);
          }
        }}
      >
        {visible.map(({ group }) => (
          <MenuRadioItem key={group.projectKey} value={group.projectKey}>
            <span className="flex min-w-0 items-center gap-2">
              <ProjectFavicon project={group} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      {visible.length === 0 ? <MenuItem disabled>No matching projects</MenuItem> : null}
    </>
  );
}

export function ThreadSwitcher(props: {
  readonly activeProject: EnvironmentProject | null;
  readonly activeThreadRef: ScopedThreadRef;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger: ReactElement;
  readonly children: ReactNode;
  readonly onNewThread: () => void;
  readonly onShowThreadActions?: (() => void) | undefined;
}) {
  // The actions menu opens once this one has closed, or the closing menu dismisses it.
  const showActionsAfterCloseRef = useRef(false);
  const { onShowThreadActions } = props;
  return (
    <Menu
      open={props.open}
      onOpenChange={props.onOpenChange}
      onOpenChangeComplete={(open) => {
        if (open || !showActionsAfterCloseRef.current) return;
        showActionsAfterCloseRef.current = false;
        onShowThreadActions?.();
      }}
    >
      <MenuTrigger render={props.trigger}>{props.children}</MenuTrigger>
      <MenuPopup align="start" className="w-80">
        <ThreadSwitcherContent
          activeProject={props.activeProject}
          activeThreadRef={props.activeThreadRef}
          onOpenChange={props.onOpenChange}
          onNewThread={props.onNewThread}
          onShowThreadActions={
            onShowThreadActions
              ? () => {
                  showActionsAfterCloseRef.current = true;
                }
              : undefined
          }
        />
      </MenuPopup>
    </Menu>
  );
}

function ThreadSwitcherContent(props: {
  readonly activeProject: EnvironmentProject | null;
  readonly activeThreadRef: ScopedThreadRef;
  readonly onOpenChange: (open: boolean) => void;
  readonly onNewThread: () => void;
  readonly onShowThreadActions?: (() => void) | undefined;
}) {
  const [query, setQuery] = useState("");
  const groups = useSidebarProjectGroups();
  const activeProjectRef = props.activeProject
    ? scopeProjectRef(props.activeProject.environmentId, props.activeProject.id)
    : null;
  const projectRefs = activeProjectRef
    ? (groups.find((group) =>
        group.memberProjectRefs.some(
          (ref) => scopedProjectKey(ref) === scopedProjectKey(activeProjectRef),
        ),
      )?.memberProjectRefs ?? [activeProjectRef])
    : [];
  const threads = useThreadShellsForProjectRefs(projectRefs);
  const hiddenThreadKeys = useHiddenThreadKeys();
  const sortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const router = useRouter();
  const normalizedQuery = query.toLowerCase();
  const activeThreadKey = threadKey(props.activeThreadRef);
  // Shells hold only the newest settled threads; a search reads every older page in scope.
  const olderSettledShelf = useOlderSettledShelf({
    scopes: olderSettledScopes(projectRefs),
    expanded: true,
    visibleCount: query === "" ? THREAD_ROW_CAP : Number.POSITIVE_INFINITY,
  });
  const listed = buildThreadSwitcherThreads({
    threads,
    projectRefs,
    hiddenThreadKeys,
    sortOrder,
    currentThreadRef: props.activeThreadRef,
  }).filter(
    (thread) =>
      thread.settledOverride !== "settled" ||
      olderSettledShelf.isListed(thread) ||
      threadKey(scopeThreadRef(thread.environmentId, thread.id)) === activeThreadKey,
  );
  useOlderSettledShelfGrowth(
    olderSettledShelf,
    listed.filter((thread) => thread.settledOverride === "settled"),
  );
  const matches = listed.filter((thread) => thread.title.toLowerCase().includes(normalizedQuery));
  const visible = matches.slice(0, THREAD_ROW_CAP);
  const moreCount =
    matches.length - visible.length + (query === "" ? olderSettledShelf.unloadedCount(threads) : 0);
  return (
    <>
      <MenuSearchInput
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="Search threads"
        aria-label="Search threads"
      />
      {query === "" ? (
        <>
          <MenuItem
            onClick={() => {
              props.onOpenChange(false);
              props.onNewThread();
            }}
          >
            <PlusIcon aria-hidden />
            New thread
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      <MenuRadioGroup
        value={activeThreadKey}
        onValueChange={(value) => {
          props.onOpenChange(false);
          if (value === activeThreadKey) return;
          const thread = matches.find(
            (candidate) =>
              threadKey(scopeThreadRef(candidate.environmentId, candidate.id)) === value,
          );
          if (!thread) return;
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
          });
        }}
      >
        {visible.map((thread) => {
          const key = threadKey(scopeThreadRef(thread.environmentId, thread.id));
          return (
            <MenuRadioItem key={key} value={key}>
              <span className="flex min-w-0 items-center gap-2">
                {thread.pinnedAt !== null ? (
                  <PinIcon aria-hidden className="size-3.5 shrink-0" />
                ) : null}
                <span className="min-w-0 flex-1 truncate" dir={textDirection(thread.title)}>
                  {thread.title}
                </span>
              </span>
            </MenuRadioItem>
          );
        })}
      </MenuRadioGroup>
      {olderSettledShelf.loading ? (
        <MenuItem disabled>Loading older threads...</MenuItem>
      ) : moreCount > 0 ? (
        <MenuItem disabled>{moreCount} more. Type to filter.</MenuItem>
      ) : null}
      {matches.length === 0 && query !== "" && !olderSettledShelf.loading ? (
        <MenuItem disabled>No matching threads</MenuItem>
      ) : null}
      {props.onShowThreadActions ? (
        <>
          <MenuSeparator />
          <MenuItem
            onClick={() => {
              props.onOpenChange(false);
              props.onShowThreadActions?.();
            }}
          >
            <EllipsisIcon aria-hidden />
            Thread actions
          </MenuItem>
        </>
      ) : null}
    </>
  );
}
