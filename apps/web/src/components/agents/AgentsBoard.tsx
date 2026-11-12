import { AgentGatewayStatus } from "./AgentGatewayStatus";
import { AgentRunDragArea, LinkableAgentCard, SortableAgentThreads } from "./SortableAgentThreads";
import { useClientSettings } from "../../hooks/useSettings";
import { visibleAgentProviders } from "./agentModelCatalog";
import { ThreadCard } from "./ThreadCard";
import { useAgentThreadContextMenu, useAgentThreadSettleAction } from "./useAgentThreadContextMenu";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  AgentRailTile,
  agentRailCountClass,
  agentRailGlyphClass,
  agentRailRowClass,
} from "./AgentRailTile";
import { groupAgentsByRole } from "@t3tools/client-runtime/state/agentIdentity";
import { Link, Outlet, useLocation, useNavigate, type LinkProps } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import {
  PlusIcon,
  ArrowLeftIcon,
  SettingsIcon,
  SearchIcon,
  TagsIcon,
  XIcon,
  UsersRoundIcon,
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
} from "lucide-react";
import type { McpGatewayProfile } from "@t3tools/contracts";
import { addPresetSkills, type AgentPreset } from "@t3tools/shared/agentPresets";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useAgentLibrary } from "../../hooks/useAgentLibrary";
import {
  useScheduledTasks,
  useScheduledTasksSupported,
  useScheduledWakeThreadKeys,
} from "../../state/scheduledTasks";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useAllEnvironmentShellsBootstrapped } from "../../state/entities";
import { useAgentThreadShells } from "./useAgentRunParenting";
import { AgentSkillsEditor } from "./AgentSkillsEditor";
import { AgentEditor } from "./AgentEditor";
import { AgentPresetPicker } from "./AgentPresetPicker";
import { randomUUID } from "../../lib/utils";
import { AgentTaskDialog } from "./AgentTaskDialog";
import { AgentsLoadingNotice } from "./AgentsLoadingNotice";
import { useAgentsPaneWidths } from "./useAgentsPaneWidths";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import {
  agentColorFor,
  agentRunParentKey,
  excludePinnedAgentThreads,
  groupAgentThreads,
  nestAgentRuns,
  selectAgentSidebarThreads,
  selectAgentWorkspaceThreads,
  selectPinnedAgentThreads,
  selectAgentRunPendingWork,
  type AgentCardChildren,
  type AgentRunContextMenu,
  type AgentRunPendingWork,
} from "./agents.logic";
import { DesktopUpdateButton } from "../sidebar/SidebarUpdatePill";
import { useToggleWorkspaceView } from "../sidebar/mainAppLocation";
import { BrandMark } from "../BrandMark";
import { openCommandPalette } from "../../commandPaletteBus";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";

const agentFilterSchema = Schema.NullOr(Schema.String);
const agentOrderSchema = Schema.Array(Schema.String);
const emptyAgentOrder: readonly string[] = [];

type AgentEditorState =
  | { readonly step: "start"; readonly presets: ReadonlyArray<AgentPreset> | null }
  | {
      readonly step: "new";
      readonly preset: AgentPreset | null;
      readonly presets: ReadonlyArray<AgentPreset> | null;
    }
  | { readonly step: "edit"; readonly profile: McpGatewayProfile };

function AgentThreadList({
  threads,
  pinned,
  onContextMenu,
  onSettleAction,
  profiles,
  childrenByKey,
  pendingWork,
  runByKey,
}: {
  profiles: readonly McpGatewayProfile[];
  threads: readonly EnvironmentThreadShell[];
  pinned: readonly EnvironmentThreadShell[];
  childrenByKey: ReadonlyMap<string, AgentCardChildren<EnvironmentThreadShell>>;
  pendingWork: ReadonlyMap<string, AgentRunPendingWork>;
  runByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  onContextMenu: AgentRunContextMenu;
  onSettleAction: (thread: EnvironmentThreadShell) => void;
}) {
  const [settledOpen, setSettledOpen] = useState(false);
  const active = threads.filter((thread) => thread.settledAt === null);
  const settled = threads.filter((thread) => thread.settledAt !== null);
  const renderCard = (thread: EnvironmentThreadShell, dragging = false) => {
    const key = `${thread.environmentId}:${thread.id}`;
    const childRuns = childrenByKey.get(key);
    return (
      <ThreadCard
        key={key}
        thread={thread}
        dragging={dragging}
        profile={profiles.find(
          (profile) => profile.profileId === thread.profileSnapshot?.profileId,
        )}
        profiles={profiles}
        childRuns={childRuns}
        pendingWork={pendingWork.get(key) ?? null}
        childPendingWork={childRuns ? pendingWork : undefined}
        parentRun={(() => {
          const parentKey = agentRunParentKey(thread);
          return parentKey === null ? null : runByKey.get(parentKey);
        })()}
        settleSupported
        onSettleAction={onSettleAction}
        onContextMenu={onContextMenu}
      />
    );
  };
  const linkableCard = (thread: EnvironmentThreadShell) => (
    <LinkableAgentCard key={`${thread.environmentId}:${thread.id}`} thread={thread}>
      {renderCard(thread)}
    </LinkableAgentCard>
  );
  return (
    <AgentRunDragArea active={active}>
      <div className="agent-thread-list">
        {pinned.length > 0 && (
          <div className="agent-pinned" aria-label="Pinned chats">
            <div className="agent-pinned-label">Pinned</div>
            {pinned.map(linkableCard)}
          </div>
        )}
        <SortableAgentThreads threads={active}>{renderCard}</SortableAgentThreads>
        {settled.length > 0 && (
          <details
            className="agent-settled"
            open={settledOpen}
            onToggle={(event) => setSettledOpen(event.currentTarget.open)}
          >
            <summary>Settled · {settled.length}</summary>
            {settledOpen && <div className="agent-thread-list">{settled.map(linkableCard)}</div>}
          </details>
        )}
      </div>
    </AgentRunDragArea>
  );
}

function TopbarIconLink({
  label,
  children,
  ...link
}: Pick<LinkProps, "to" | "search"> & { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link {...link} aria-label={label} className="agent-icon-button">
            {children}
          </Link>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function AgentsBoard() {
  const { profiles, skills, skillsAvailable, skillResourcesAvailable, available, updateSettings } =
    useAgentLibrary();
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [order, setOrder] = useLocalStorage(
    "t3code:agents:column-order",
    emptyAgentOrder,
    agentOrderSchema,
  );
  const ranks = new Map(order.map((id, index) => [id, index]));
  const orderedProfiles = profiles.toSorted(
    (a, b) => (ranks.get(a.profileId) ?? order.length) - (ranks.get(b.profileId) ?? order.length),
  );
  const [groupByRole, setGroupByRole] = useLocalStorage(
    "t3code:agents:group-by-role",
    false,
    Schema.Boolean,
  );
  const railGroups = groupByRole
    ? groupAgentsByRole(orderedProfiles)
    : [{ tag: null, label: "Agents", profiles: orderedProfiles }];
  /** Swaps two agents in the saved order, so a move within a role group follows what is shown. */
  const swapAgents = (first: string, second: string | undefined) => {
    if (second === undefined) return;
    const ids = orderedProfiles.map((profile) => profile.profileId);
    const a = ids.indexOf(first);
    const b = ids.indexOf(second);
    if (a < 0 || b < 0) return;
    [ids[a], ids[b]] = [second, first];
    setOrder(ids);
  };
  const { environments } = useEnvironments();
  const machineLabels = new Map(environments.map((env) => [env.environmentId, env.label]));
  const providersByEnvironment = useEnvironmentProviders();
  const navigate = useNavigate();
  const toggleWorkspaceView = useToggleWorkspaceView();
  const scheduledSupported = useScheduledTasksSupported();
  const scheduledTasks = useScheduledTasks();
  const scheduledWakeKeys = useScheduledWakeThreadKeys();
  const modelPreferences = useClientSettings((settings) => settings.providerModelPreferences);
  // Pending parent changes show at once (see useSetAgentRunParent).
  const threads = useAgentThreadShells();
  // Delegated tasks live in the thread details' Lineage section, never this roster.
  const sidebarThreads = selectAgentSidebarThreads(threads);
  const ready = useAllEnvironmentShellsBootstrapped();
  const [editor, setEditor] = useState<AgentEditorState | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [savedFilter, setFilter] = useLocalStorage("t3code:agents:filter", null, agentFilterSchema);
  const filter = profiles.some((profile) => profile.profileId === savedFilter) ? savedFilter : null;
  const [showFilters, setShowFilters] = useState(false);
  const { attachWorkspace, paneStyle, profilesHandlers, threadsHandlers } = useAgentsPaneWidths();
  const selected = useLocation({
    select: (location) => location.pathname.split("/").filter(Boolean).length > 1,
  });
  const [deleting, setDeleting] = useState<McpGatewayProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const { groups, orphaned } = groupAgentThreads(profiles, sidebarThreads);
  const allThreads = [...groups.values(), orphaned].flat();
  // Pinned chats stay at the top of the list no matter which agent filter or
  // search is active, so they are selected outside the filtered set.
  const allPinned = selectPinnedAgentThreads(allThreads);
  // Runs another run created fold into that run's card (see nestAgentRuns).
  const { active, settled } = selectAgentWorkspaceThreads(sidebarThreads, filter, query);
  const { lists: nestedLists, childrenByKey } = nestAgentRuns({
    lists: {
      pinned: allPinned,
      active: excludePinnedAgentThreads(active, allPinned),
      settled: excludePinnedAgentThreads(settled, allPinned),
    },
    all: sidebarThreads,
  });
  // Every chat, subagents included: children and subagents both keep a parent busy.
  const pendingWork = selectAgentRunPendingWork(threads, scheduledWakeKeys);
  const pinned = nestedLists.pinned;
  const visible = [...nestedLists.active, ...nestedLists.settled];
  const runByKey = new Map(
    threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread]),
  );
  const onThreadContextMenu = useAgentThreadContextMenu(visible);
  const onSettleAction = useAgentThreadSettleAction();
  const activeCount = (items: readonly EnvironmentThreadShell[]) =>
    items.filter((thread) => thread.settledAt === null).length;
  const online = environments.filter((env) => env.connection.phase === "connected");
  // The page reads every connected server, so one offering pull requests is enough.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  const allTile = (
    <button
      type="button"
      className={agentRailRowClass}
      aria-current={filter === null ? "true" : undefined}
      aria-label={`All agents, ${activeCount(allThreads)} active`}
      onClick={() => {
        setFilter(null);
        setShowFilters(false);
      }}
    >
      <span className={agentRailGlyphClass} aria-hidden="true">
        <UsersRoundIcon />
      </span>
      <span className="min-w-0 flex-1 truncate">All agents</span>
      <span className={agentRailCountClass} aria-hidden="true">
        {activeCount(allThreads)}
      </span>
    </button>
  );
  return (
    <div className="agents-page" data-thread-selected={selected} data-show-filters={showFilters}>
      <header className="agents-topbar">
        <Link to="/" className="agents-brand">
          <BrandMark className="size-4" />
          <strong>T3</strong>
          <span>/ agents</span>
        </Link>
        <nav aria-label="Workspace view">
          <span aria-current="page">Agents</span>
          <Link
            to="/"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey) return;
              // Return to the chat left open in the threads view, not a fresh draft.
              event.preventDefault();
              void toggleWorkspaceView("threads");
            }}
          >
            Threads
          </Link>
        </nav>
        <div className="agents-search">
          <SearchIcon size={15} aria-hidden="true" />
          <input
            type="text"
            role="searchbox"
            aria-label="Search all chats"
            placeholder="Search all chats…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
            }}
          />
          {query && (
            <button aria-label="Clear chat search" onClick={() => setQuery("")}>
              <XIcon size={14} />
            </button>
          )}
        </div>
        <AgentGatewayStatus />
        <div className="agents-topbar-actions">
          <div className="agents-topbar-group">
            <button
              className="agent-icon-button"
              disabled={!skillsAvailable}
              onClick={() => setSkillsOpen(true)}
            >
              Skills
            </button>
            <button
              className="agent-icon-button"
              onClick={() => openCommandPalette({ open: "add-project" })}
            >
              <PlusIcon size={14} /> Add project
            </button>
          </div>
          <div className="agents-topbar-group agents-topbar-icons">
            <DesktopUpdateButton className="agent-icon-button agent-update-button" />
            {pullRequestsSupported && (
              <TopbarIconLink
                label="Pull Requests"
                to="/pull-requests"
                search={readPullRequestListPreferences()}
              >
                <PullRequestGlyph.pullRequest className="size-[15px]" />
              </TopbarIconLink>
            )}
            <TopbarIconLink label="Usage" to="/usage">
              <ChartNoAxesColumnIcon size={15} />
            </TopbarIconLink>
            <TopbarIconLink label="Settings" to="/settings">
              <SettingsIcon size={15} />
            </TopbarIconLink>
          </div>
        </div>
      </header>
      {!available && (
        <p role="status" className="agents-notice">
          Connect an environment with agent sync support to create or edit agents.
        </p>
      )}
      <AgentsLoadingNotice ready={ready} />
      <main
        ref={attachWorkspace}
        className="agents-workspace"
        aria-label="Agents workspace"
        style={paneStyle}
      >
        <aside className="agents-filters" aria-label="Agent filters">
          <header className="flex items-center gap-1 ps-2 pb-2">
            <h2 className="min-w-0 flex-1 text-base font-semibold">Agents</h2>
            {profiles.length > 0 && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Toggle
                      variant="ghost"
                      size="sm"
                      aria-label="Group by role"
                      pressed={groupByRole}
                      onPressedChange={setGroupByRole}
                    />
                  }
                >
                  <TagsIcon />
                </TooltipTrigger>
                <TooltipPopup side="bottom">Group by role</TooltipPopup>
              </Tooltip>
            )}
            <Button
              size="sm"
              disabled={!available}
              onClick={() => setEditor({ step: "start", presets: null })}
            >
              <PlusIcon />
              New agent
            </Button>
          </header>
          {groupByRole && <div className="flex flex-col gap-0.5">{allTile}</div>}
          {railGroups.map((group) => (
            <section
              key={group.tag === null ? "untagged" : `tag:${group.tag}`}
              className="flex flex-col"
              aria-label={groupByRole ? group.label : undefined}
            >
              {groupByRole && (
                <h3 className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">
                  {group.label}
                </h3>
              )}
              <div className="flex flex-col gap-0.5">
                {!groupByRole && allTile}
                {group.profiles.map((profile, index) => {
                  const previous = group.profiles[index - 1]?.profileId;
                  const next = group.profiles[index + 1]?.profileId;
                  return (
                    <AgentRailTile
                      key={profile.profileId}
                      profile={profile}
                      color={agentColorFor(profile, profiles)}
                      activeCount={activeCount(groups.get(profile.profileId) ?? [])}
                      selected={filter === profile.profileId}
                      machineLabels={machineLabels}
                      onSelect={() => {
                        setFilter(profile.profileId);
                        setShowFilters(false);
                      }}
                      actions={{
                        editDisabled: !available,
                        scheduleDisabled: scheduledSupported
                          ? !available || profile.runtimeMode === "read-only"
                          : null,
                        moveUpDisabled: previous === undefined,
                        moveDownDisabled: next === undefined,
                        onEdit: () => setEditor({ step: "edit", profile }),
                        onSchedule: () =>
                          navigate({
                            to: "/agents/scheduled",
                            search: { agent: profile.profileId },
                          }),
                        onMoveUp: () => swapAgents(profile.profileId, previous),
                        onMoveDown: () => swapAgents(profile.profileId, next),
                        onDelete: () => {
                          setDeleting(profile);
                          setDeleteError("");
                        },
                      }}
                    />
                  );
                })}
              </div>
            </section>
          ))}
          {profiles.length === 0 && (
            <p className="agent-empty">No agents yet. Create an agent to start a chat.</p>
          )}
          {scheduledSupported && (
            <footer className="agents-filters-footer">
              <Link
                to="/agents/scheduled"
                className={agentRailRowClass}
                activeProps={{ "aria-current": "page" }}
                onClick={() => setShowFilters(false)}
              >
                <span className={agentRailGlyphClass} aria-hidden="true">
                  <CalendarClockIcon />
                </span>
                <span className="min-w-0 flex-1 truncate">Scheduled tasks</span>
                <span className={agentRailCountClass}>
                  {scheduledTasks.filter(({ task }) => task.enabled).length}
                </span>
              </Link>
            </footer>
          )}
        </aside>
        <div className="agents-pane-resize" data-pane="profiles">
          <RightPanelResizeHandle handlers={profilesHandlers} />
        </div>
        <section className="agents-threads" aria-label="Threads">
          <header>
            <div className="agent-mobile-filters">
              <Button variant="outline" size="sm" onClick={() => setShowFilters(true)}>
                <ArrowLeftIcon />
                Agents
              </Button>
            </div>
            <div className="agents-threads-heading">
              <h2>
                Threads
                {filter !== null
                  ? ` · ${profiles.find((profile) => profile.profileId === filter)?.name ?? "Agent unavailable"}`
                  : ""}
              </h2>
              <p>Active & unread</p>
            </div>
            <Button
              type="button"
              size="sm"
              aria-haspopup="dialog"
              disabled={!available || orderedProfiles.length === 0}
              onClick={() => setNewChatOpen(true)}
            >
              <PlusIcon />
              New chat
            </Button>
          </header>
          {visible.length === 0 && pinned.length === 0 && (
            <p role="status" className="agent-empty">
              {query ? "No chats match your search." : "No threads here yet."}
            </p>
          )}
          <AgentThreadList
            threads={visible}
            pinned={pinned}
            profiles={profiles}
            childrenByKey={childrenByKey}
            pendingWork={pendingWork}
            runByKey={runByKey}
            onContextMenu={onThreadContextMenu}
            onSettleAction={onSettleAction}
          />
        </section>
        <div className="agents-pane-resize" data-pane="threads">
          <RightPanelResizeHandle handlers={threadsHandlers} />
        </div>
        <section className="agents-chat-pane">
          <Outlet />
        </section>
      </main>
      {skillsOpen && (
        <AgentSkillsEditor
          skills={skills}
          onClose={() => setSkillsOpen(false)}
          onSave={(agentSkills) => updateSettings({ agentSkills })}
        />
      )}
      {editor?.step === "start" && (
        <AgentPresetPicker
          loadedPresets={editor.presets}
          onScratch={() => setEditor({ step: "new", preset: null, presets: editor.presets })}
          onPick={(preset, presets) => setEditor({ step: "new", preset, presets })}
          onClose={() => setEditor(null)}
        />
      )}
      {editor !== null && editor.step !== "start" && (
        <AgentEditor
          key={editor.step === "new" ? (editor.preset?.id ?? "scratch") : editor.profile.profileId}
          profile={editor.step === "edit" ? editor.profile : null}
          preset={editor.step === "new" ? editor.preset : null}
          skillsAvailable={skillsAvailable}
          profiles={profiles}
          skills={skills}
          providers={online.flatMap((env) =>
            env.serverConfig
              ? visibleAgentProviders(
                  env.environmentId,
                  providersByEnvironment.get(env.environmentId) ?? [],
                  {
                    providerModelPreferences: modelPreferences,
                  },
                )
              : [],
          )}
          machines={environments}
          {...(editor.step === "new" && {
            onBack: () =>
              setEditor({ step: "start", presets: editor.preset ? editor.presets : null }),
          })}
          onClose={() => setEditor(null)}
          onSave={(profile, presetSkills) => {
            if (editor.step === "edit")
              return updateSettings({
                mcpGatewayProfiles: profiles.map((item) =>
                  item.profileId === profile.profileId ? profile : item,
                ),
              });
            if (presetSkills.length === 0)
              return updateSettings({ mcpGatewayProfiles: [...profiles, profile] });
            if (presetSkills.some((skill) => skill.resources.length) && !skillResourcesAvailable)
              throw new Error("Update T3 Code on this machine to add this preset’s skill files.");
            const added = addPresetSkills(skills, presetSkills, {
              now: profile.createdAt,
              makeId: randomUUID,
            });
            return updateSettings({
              agentSkills: added.agentSkills,
              mcpGatewayProfiles: [
                ...profiles,
                {
                  ...profile,
                  skillIds: [...new Set([...(profile.skillIds ?? []), ...added.skillIds])],
                },
              ],
            });
          }}
        />
      )}
      {newChatOpen && (
        <AgentTaskDialog
          profiles={profiles}
          orderedProfiles={orderedProfiles}
          onClose={() => setNewChatOpen(false)}
        />
      )}
      {deleting && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setDeleting(null);
          }}
        >
          <DialogPopup>
            <div className="agent-dialog p-6">
              <DialogTitle>Delete {deleting.name}?</DialogTitle>
              <DialogDescription className="mt-2">
                Existing threads will remain visible in All. This does not stop running work.
              </DialogDescription>
              {deleteError && <p role="alert">{deleteError}</p>}
              <div className="agent-form">
                <footer>
                  <button disabled={busy} onClick={() => setDeleting(null)}>
                    Cancel
                  </button>
                  <button
                    className="agent-primary"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const deleted = await updateSettings({
                          mcpGatewayProfiles: profiles.filter(
                            (p) => p.profileId !== deleting.profileId,
                          ),
                        });
                        if (deleted) setDeleting(null);
                        else setDeleteError("Could not delete the agent. Try again.");
                      } catch (cause) {
                        setDeleteError(
                          cause instanceof Error ? cause.message : "Could not delete the agent.",
                        );
                      }
                      setBusy(false);
                    }}
                  >
                    {busy ? "Deleting…" : "Delete agent"}
                  </button>
                </footer>
              </div>
            </div>
          </DialogPopup>
        </Dialog>
      )}
    </div>
  );
}
