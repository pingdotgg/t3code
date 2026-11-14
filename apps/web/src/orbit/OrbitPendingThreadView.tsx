import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OrbitThreadStart } from "@t3tools/client-runtime/orbit-gateway";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import { OrbitSetupCard } from "../components/chat/OrbitSetupCard";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { useThreadShell } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import type { DraftId } from "../composerDraftStore";
import { openOrbitDraft } from "./openOrbitDraft";
import { openOrbitInstanceById } from "./openOrbitInstance";
import { requestOrbitBranchMenu, takeOrbitBranchMenuRequest } from "./orbitBranchControl";
import { readOrbitEnvironments } from "./orbitPaletteProjects";
import type { OrbitDraftTarget } from "./orbitDraft";
import { openOrbitInstanceStep } from "./orbitInstanceStep";
import { desktopOrbitGatewayClient } from "./OrbitProfileSync";
import {
  ORBIT_INSTANCE_STAYS_LINE,
  ORBIT_SETUP_CANCELLED_TITLE,
  orbitSetupView,
} from "./orbitSetupView";
import {
  cancelOrbitThreadStart,
  dismissOrbitThreadStart,
  orbitThreadStartBlockedReason,
  retryOrbitThreadStart,
} from "./orbitThreadStarts";
import { useOrbitCreateOperations, useOrbitThreadStarts } from "./orbitThreadStartStore";

/** How long the handover waits for the thread to reach this window before it opens it anyway. */
const HANDOVER_WAIT_MS = 5_000;

/** The draft target a failed start goes back to, with its name, for Change name. */
export function orbitStartDraftTarget(start: OrbitThreadStart): OrbitDraftTarget {
  return {
    projectId: start.projectId,
    projectSlug: start.projectSlug,
    projectName: start.projectName ?? start.projectSlug,
    nodeName: start.nodeName,
    instanceKind: "new",
    instanceName: start.instanceName,
    existing: null,
    domainSuffix: start.instanceDomainSuffix ?? null,
    branch: start.branch ?? null,
    defaultBranch: start.defaultBranch ?? null,
  };
}

/**
 * Conn: the thread started in an Orbit Project, before the clone's server exists. It shows the
 * message and the setup card from the saved start, and hands over to the real thread once the
 * clone took the first message. A reload lands here again and the runner resumes the start.
 */
export function OrbitPendingThreadView({ startId }: { startId: string }) {
  const start = useOrbitThreadStarts(
    (state) => state.starts.find((entry) => entry.id === startId) ?? null,
  );
  const create = useOrbitCreateOperations((state) => state.byStart[startId] ?? null);
  const navigate = useNavigate();
  const router = useRouter();
  const handoverEnvironmentId = start?.sentAt != null ? start.environmentId : null;
  const handoverThreadId = handoverEnvironmentId === null ? null : (start?.threadId ?? null);
  const threadRef =
    handoverEnvironmentId !== null && handoverThreadId !== null
      ? scopeThreadRef(EnvironmentId.make(handoverEnvironmentId), ThreadId.make(handoverThreadId))
      : null;
  const threadShown = useThreadShell(threadRef) !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the route over once the clone's thread reached this window
  useEffect(() => {
    if (handoverEnvironmentId === null || handoverThreadId === null) return;
    const ref = scopeThreadRef(
      EnvironmentId.make(handoverEnvironmentId),
      ThreadId.make(handoverThreadId),
    );
    const open = () =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
        replace: true,
      });
    if (threadShown) {
      open();
      return;
    }
    const timer = setTimeout(open, HANDOVER_WAIT_MS);
    return () => clearTimeout(timer);
  }, [navigate, handoverEnvironmentId, handoverThreadId, threadShown]);

  if (start === null) {
    return (
      <PendingThreadShell header={null}>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>This thread start is gone</EmptyTitle>
            <EmptyDescription>It was dismissed on this device.</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" onClick={() => void navigate({ to: "/" })}>
            New thread
          </Button>
        </Empty>
      </PendingThreadShell>
    );
  }

  /** Carries the message, model and modes into the reopened draft, then drops the saved start. */
  const moveToDraft = (draftId: DraftId) => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, start.message);
    if (start.modelSelection) store.setModelSelection(draftId, start.modelSelection);
    if (start.runtimeMode) store.setRuntimeMode(draftId, start.runtimeMode);
    if (start.interactionMode) store.setInteractionMode(draftId, start.interactionMode);
    // Offered only when the create made no Instance, so only the saved start goes.
    dismissOrbitThreadStart(start.id);
  };
  const reopenDraft = async (): Promise<OrbitDraftTarget | null> => {
    const target = orbitStartDraftTarget(start);
    const draftId = await openOrbitDraft(router, target);
    if (draftId === null) {
      toastManager.add({
        type: "error",
        title: "Could not reopen the draft",
        description:
          orbitThreadStartBlockedReason() ??
          `Start a new thread in ${start.projectSlug} from the palette instead.`,
      });
      return null;
    }
    moveToDraft(draftId);
    return target;
  };
  const changeName = async () => {
    const target = await reopenDraft();
    if (target) openOrbitInstanceStep(target);
  };
  const changeBranch = async () => {
    // The menu opens once the draft's context row shows.
    requestOrbitBranchMenu(start.projectId);
    if ((await reopenDraft()) === null) takeOrbitBranchMenuRequest(start.projectId);
  };
  const openHolder = async (instance: { readonly id: number; readonly name: string }) => {
    const target = orbitStartDraftTarget(start);
    const result = await openOrbitInstanceById({
      router,
      project: {
        id: target.projectId,
        slug: target.projectSlug,
        name: target.projectName,
        nodeName: target.nodeName,
        domainSuffix: target.domainSuffix,
      },
      instance,
      environments: readOrbitEnvironments,
    }).catch((error: unknown) => ({
      kind: "unavailable" as const,
      reason: error instanceof Error ? error.message : String(error),
    }));
    if (result.kind === "opened") {
      moveToDraft(result.draftId);
      return;
    }
    toastManager.add({
      type: "error",
      title: `Could not open Instance ${instance.name}`,
      description: result.reason,
    });
  };

  const cancel = async () => {
    try {
      const { instanceStays, requested } = await cancelOrbitThreadStart(
        desktopOrbitGatewayClient(),
        start.id,
      );
      void navigate({ to: "/", replace: true });
      // A requested cancel ends once Orbit admitted the create; the runner reports it then.
      if (requested) return;
      toastManager.add({
        type: "info",
        title: ORBIT_SETUP_CANCELLED_TITLE,
        ...(instanceStays ? { description: ORBIT_INSTANCE_STAYS_LINE } : {}),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not cancel the Instance setup",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <PendingThreadShell
      startId={start.id}
      header={
        <>
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {start.message.split("\n")[0]}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {start.instanceName} · {start.projectSlug}
          </span>
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both bg-background">
        <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col px-4 pt-6">
          <div className="flex justify-end pb-4">
            <div
              data-orbit-pending-message
              className="max-w-[80%] rounded-bubble border-t border-t-(--message-highlight)! bg-message px-4 pt-2.5 pb-3 text-sm whitespace-pre-wrap text-message-foreground"
            >
              {start.message}
            </div>
          </div>
          <OrbitSetupCard
            view={orbitSetupView(start, create)}
            onRetry={() => retryOrbitThreadStart(start.id)}
            onChangeName={() => void changeName()}
            onChangeBranch={() => void changeBranch()}
            onOpenInstance={(instance) => void openHolder(instance)}
            onDismiss={() => {
              dismissOrbitThreadStart(start.id);
              void navigate({ to: "/", replace: true });
            }}
            onCancel={() => void cancel()}
          />
        </div>
      </div>
    </PendingThreadShell>
  );
}

/** ChatView's frame: the shell fill, its header height and its card, so the handover keeps them. */
function PendingThreadShell({
  startId,
  header,
  children,
}: {
  startId?: string;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh" data-orbit-pending-thread={startId}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-(--shell-fill) backdrop-blur-(--shell-blur) backdrop-saturate-(--shell-saturate)">
        <header
          className={cn(
            "flex h-(--shell-header-height) min-h-(--shell-header-height) shrink-0 items-center gap-3",
            isElectron
              ? "drag-region px-3 sm:px-5"
              : "pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          {header}
        </header>
        <div
          data-shell-sidebar-edge=""
          className="relative z-0 mr-(--shell-inset) mb-(--shell-inset) flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-tr-(--shell-corner) rounded-br-(--shell-corner) shell-inner-panel [--background:var(--shell-card)]"
        >
          {children}
        </div>
      </div>
    </SidebarInset>
  );
}
