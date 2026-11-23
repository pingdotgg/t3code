import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  dueCardCount,
  waitingForUser,
  WORKSTREAM_STATES,
} from "@t3tools/client-runtime/state/kompas";
import type { ThreadId, Workstream, WorkstreamThreadState } from "@t3tools/contracts";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import {
  ArrowLeftIcon,
  BookOpenIcon,
  FolderIcon,
  LayoutListIcon,
  LightbulbIcon,
  MessageCircleIcon,
  PlugIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../components/ui/sidebar";
import { SidebarChromeHeader } from "../components/sidebar/SidebarChrome";
import { SidebarUpdatePill } from "../components/sidebar/SidebarUpdatePill";
import { isElectron } from "../env";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { cn } from "../lib/utils";
import { useVisibleThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { useModelName } from "./ModelField";
import { type Kompas, useKompas, useStartConversation, useWorkstreamOf } from "./state";
import { WorkstreamPanelDialog } from "./Workstreams";

const RECENT_CONVERSATIONS = 40;

function GroupLabel({ children }: { readonly children: ReactNode }) {
  return (
    <div className="px-2 pt-3 pb-1 font-semibold text-sidebar-muted-foreground text-xs uppercase tracking-wide">
      {children}
    </div>
  );
}

function NavItem({
  to,
  icon,
  label,
  badge,
  active,
  onNavigate,
}: {
  readonly to: "/" | "/workstreams" | "/study" | "/plugins" | "/memory";
  readonly icon: ReactNode;
  readonly label: string;
  readonly badge?: number;
  readonly active: boolean;
  readonly onNavigate: () => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={active} render={<Link to={to} onClick={onNavigate} />}>
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {badge === undefined || badge === 0 ? null : <Badge>{badge}</Badge>}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function ThreadLink({
  environmentId,
  threadId,
  active,
  children,
  onNavigate,
}: {
  readonly environmentId: Parameters<typeof scopeThreadRef>[0];
  readonly threadId: ThreadId;
  readonly active: boolean;
  readonly children: ReactNode;
  readonly onNavigate: () => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        size={typeof children === "string" ? "default" : "lg"}
        render={
          <Link
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams(scopeThreadRef(environmentId, threadId))}
            onClick={onNavigate}
          />
        }
      >
        {typeof children === "string" ? (
          <span className="min-w-0 flex-1 truncate">{children}</span>
        ) : (
          children
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function useWorkstreamStateLabel() {
  const gt = useGT();
  return (state: WorkstreamThreadState) =>
    ({
      needs_input: gt("Waiting for you"),
      working: gt("Working"),
      idle: gt("Ready to check"),
      failed: gt("Failed"),
      resolved: gt("Done"),
    })[state];
}

function ProjectSidebar(props: {
  readonly kompas: Kompas;
  readonly environmentId: Parameters<typeof scopeThreadRef>[0];
  readonly workstream: Workstream;
  readonly activeThreadId: string;
  readonly onNavigate: () => void;
}) {
  const { workstream } = props;
  const [panelOpen, setPanelOpen] = useState(false);
  const modelName = useModelName(props.environmentId);
  const stateLabel = useWorkstreamStateLabel();
  const gt = useGT();
  return (
    <SidebarContent>
      <SidebarGroup>
        <Link
          to="/workstreams"
          onClick={props.onNavigate}
          className="flex items-center gap-1 px-2 py-1 text-sidebar-muted-foreground text-sm hover:text-sidebar-foreground"
        >
          <ArrowLeftIcon className="size-3.5" />
          <T>Projects</T>
        </Link>
        <div className="px-2 pb-2">
          <div className="font-semibold text-base">{workstream.title}</div>
          {workstream.goal === "" ? null : (
            <p className="text-sidebar-muted-foreground text-sm">{workstream.goal}</p>
          )}
        </div>
        <SidebarMenu>
          <ThreadLink
            environmentId={props.environmentId}
            threadId={workstream.coordinatorThreadId}
            active={workstream.coordinatorThreadId === props.activeThreadId}
            onNavigate={props.onNavigate}
          >
            {gt("Coordinator")}
          </ThreadLink>
          <SidebarMenuItem className="lg:hidden">
            <SidebarMenuButton onClick={() => setPanelOpen(true)}>
              <LayoutListIcon />
              <span>{gt("Overview")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {panelOpen ? (
          <WorkstreamPanelDialog
            kompas={props.kompas}
            workstream={workstream}
            threadId={props.activeThreadId}
            onClose={() => setPanelOpen(false)}
          />
        ) : null}
        {WORKSTREAM_STATES.map((state) => {
          const threads = workstream.threads.filter((thread) => thread.state === state);
          if (threads.length === 0) return null;
          return (
            <div key={state}>
              <GroupLabel>
                <span className="flex justify-between">
                  <span>{stateLabel(state)}</span>
                  <span>{threads.length}</span>
                </span>
              </GroupLabel>
              <SidebarMenu>
                {threads.map((thread) => (
                  <ThreadLink
                    key={thread.threadId}
                    environmentId={props.environmentId}
                    threadId={thread.threadId}
                    active={thread.threadId === props.activeThreadId}
                    onNavigate={props.onNavigate}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-sidebar-foreground">
                        {thread.title}
                      </span>
                      <span
                        className={cn(
                          "block truncate text-xs",
                          state === "needs_input" && "text-warning-foreground",
                        )}
                      >
                        {[thread.lastLine, modelName(thread.model)].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </ThreadLink>
                ))}
              </SidebarMenu>
            </div>
          );
        })}
      </SidebarGroup>
    </SidebarContent>
  );
}

/** The chat-mode sidebar. Developer mode shows T3 Code's own instead. */
export function KompasSidebar() {
  const gt = useGT();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const kompas = useKompas();
  const startConversation = useStartConversation();
  const { isMobile, setOpenMobile } = useSidebar();
  const target = useThreadRouteTarget();
  const activeThreadId = target?.kind === "server" ? target.threadRef.threadId : null;
  const project = useWorkstreamOf(activeThreadId);
  const workstreams = kompas?.snapshot.workstreams ?? [];
  const coordinatorIds = new Set<string>(workstreams.map((entry) => entry.coordinatorThreadId));
  const chatProjectId = kompas?.snapshot.chatProjectId ?? null;
  const conversations = useVisibleThreadShells()
    .filter(
      (thread) =>
        thread.projectId === chatProjectId &&
        thread.environmentId === kompas?.environmentId &&
        thread.archivedAt === null &&
        thread.lineage.relationshipToParent !== "subagent" &&
        !coordinatorIds.has(thread.id),
    )
    .toSorted(
      (left, right) =>
        Date.parse(right.latestUserMessageAt ?? right.createdAt) -
        Date.parse(left.latestUserMessageAt ?? left.createdAt),
    )
    .slice(0, RECENT_CONVERSATIONS);
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const newConversation = () => {
    closeMobile();
    void startConversation();
  };

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      {project === null || kompas === null ? (
        <SidebarContent
          fixedHeader={
            <div className="px-2 pb-2">
              <Button className="w-full" size="lg" variant="outline" onClick={newConversation}>
                <PlusIcon />
                <T>New conversation</T>
              </Button>
            </div>
          }
        >
          <SidebarGroup>
            <SidebarMenu>
              <NavItem
                to="/"
                icon={<MessageCircleIcon />}
                label={gt("Conversations")}
                active={target !== null || pathname === "/"}
                onNavigate={closeMobile}
              />
              <NavItem
                to="/workstreams"
                icon={<FolderIcon />}
                label={gt("Projects")}
                badge={workstreams.reduce((total, entry) => total + waitingForUser(entry), 0)}
                active={pathname === "/workstreams"}
                onNavigate={closeMobile}
              />
              <NavItem
                to="/study"
                icon={<BookOpenIcon />}
                label={gt("Study")}
                badge={dueCardCount(kompas?.snapshot.decks ?? [])}
                active={pathname === "/study"}
                onNavigate={closeMobile}
              />
              <NavItem
                to="/plugins"
                icon={<PlugIcon />}
                label={gt("Plugins")}
                active={pathname === "/plugins"}
                onNavigate={closeMobile}
              />
              <NavItem
                to="/memory"
                icon={<LightbulbIcon />}
                label={gt("Memory")}
                badge={
                  kompas?.snapshot.memory.filter((entry) => entry.status === "proposed").length ?? 0
                }
                active={pathname === "/memory"}
                onNavigate={closeMobile}
              />
            </SidebarMenu>
            {kompas === null || workstreams.length === 0 ? null : (
              <>
                <GroupLabel>
                  <T>Projects</T>
                </GroupLabel>
                <SidebarMenu>
                  {workstreams.map((entry) => (
                    <ThreadLink
                      key={entry.id}
                      environmentId={kompas.environmentId}
                      threadId={entry.coordinatorThreadId}
                      active={false}
                      onNavigate={closeMobile}
                    >
                      {entry.title}
                    </ThreadLink>
                  ))}
                </SidebarMenu>
              </>
            )}
            {conversations.length === 0 ? null : (
              <>
                <GroupLabel>
                  <T>Recent</T>
                </GroupLabel>
                <SidebarMenu>
                  {conversations.map((thread) => (
                    <ThreadLink
                      key={thread.id}
                      environmentId={thread.environmentId}
                      threadId={thread.id}
                      active={thread.id === activeThreadId}
                      onNavigate={closeMobile}
                    >
                      {thread.title}
                    </ThreadLink>
                  ))}
                </SidebarMenu>
              </>
            )}
          </SidebarGroup>
        </SidebarContent>
      ) : (
        <ProjectSidebar
          kompas={kompas}
          environmentId={kompas.environmentId}
          workstream={project.workstream}
          activeThreadId={activeThreadId ?? ""}
          onNavigate={closeMobile}
        />
      )}
      <SidebarFooter>
        <SidebarMenu className="flex-row items-center">
          <SidebarMenuItem className="min-w-0 flex-1">
            <SidebarMenuButton
              onClick={() => {
                closeMobile();
                void navigate({ to: "/settings" });
              }}
            >
              <SettingsIcon />
              <span>
                <T>Settings</T>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarUpdatePill />
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
