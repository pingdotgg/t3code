import type {
  EditorId,
  EnvironmentId,
  PreviewAnnotationPayload,
  ProjectId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ComposerImageAttachment, DraftId } from "../../composerDraftStore";
import type { ShortcutMatchContext } from "../../keybindings";
import { type RightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { type PersistentThreadTerminalPanelProps } from "~/panels/terminal/PersistentThreadTerminalDrawer";
import { pullRequestPanelContext } from "../pullRequest/pullRequestDetail.logic";
import { PullRequestDetailGhost } from "../pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";

import { RegisteredSidePanel } from "~/panels/bundledPanels";

type RightPanelTerminalProps = Omit<
  PersistentThreadTerminalPanelProps,
  "visible" | "threadRef" | "surface"
>;

interface RightPanelPullRequestProps {
  readonly capabilityKnown: boolean;
  readonly supported: boolean;
  readonly projectId: ProjectId | null;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly linkedPullRequest: ThreadLinkedPullRequest | null;
  readonly branchPullRequest: ThreadLinkedPullRequest | null | undefined;
  readonly onBack: (() => void) | undefined;
}

interface RightPanelFileProps {
  readonly projectName: string | null;
  readonly workspaceRoot: string | undefined;
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly pendingSurfaceIds: ReadonlySet<string>;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
}

export function RightPanelSurfaceContent(props: {
  readonly surface: RightPanelSurface | null;
  readonly activeSurfaceId: string | null;
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly configuredPreviewUrls: ReadonlyArray<string>;
  readonly workspaceMutationId: string | null;
  readonly getShortcutContext: () => ShortcutMatchContext;
  readonly onSendAnnotation: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
  readonly onCloseSurface: (surface: RightPanelSurface) => void;
  readonly terminal: RightPanelTerminalProps;
  readonly pullRequest: RightPanelPullRequestProps;
  readonly files: RightPanelFileProps;
}) {
  const { surface, threadRef, visible } = props;
  if (surface === null) return null;
  switch (surface.kind) {
    case "preview":
      return (
        <RegisteredSidePanel
          id="preview"
          tabId={surface.resourceId}
          configuredUrls={props.configuredPreviewUrls}
        />
      );
    case "terminal":
      return <RegisteredSidePanel id="terminal" {...props.terminal} surface={surface} />;
    case "diff":
      return <RegisteredSidePanel key={scopedThreadKey(threadRef)} id="diff" />;
    case "pull-request": {
      const pullRequest = props.pullRequest;
      if (!pullRequest.capabilityKnown) return <PullRequestDetailGhost />;
      if (!pullRequest.supported) {
        return (
          <PullRequestsUnavailableState
            title="Pull requests unavailable"
            error="Update this environment's T3 Code server to browse pull requests."
          />
        );
      }
      return (
        <RegisteredSidePanel
          id="pull-request"
          getShortcutContext={props.getShortcutContext}
          shortcutsEnabled={visible && props.activeSurfaceId === surface.id}
          key={`${scopedThreadKey(threadRef)}:${surface.id}`}
          reference={{
            projectId: surface.projectId as ProjectId,
            ...(surface.host ? { host: surface.host } : {}),
            repository: surface.repository,
            number: surface.number,
          }}
          initialTab={surface.detailTab ?? "summary"}
          onTabChange={(tab) => {
            useRightPanelStore.getState().setPullRequestDetailTab(threadRef, surface.id, tab);
          }}
          context={pullRequestPanelContext(
            {
              projectId: pullRequest.projectId,
              pullRequests: pullRequest.pullRequests,
              linkedPullRequest: pullRequest.linkedPullRequest,
              branchPullRequest: pullRequest.branchPullRequest,
            },
            surface,
          )}
          onBack={pullRequest.onBack}
        />
      );
    }
    case "pull-requests":
      return <RegisteredSidePanel id="pull-requests" />;
    case "plugin-view":
      return <RegisteredSidePanel id="plugin-view" key={surface.id} surface={surface} />;
    case "device":
      return (
        <RegisteredSidePanel
          id="device"
          key={surface.id}
          surface={surface}
          onDismissSetup={() => {
            props.onCloseSurface(surface);
            useRightPanelStore.getState().show(threadRef);
          }}
        />
      );
    case "files":
    case "file": {
      const files = props.files;
      const attachment = surface.kind === "file" ? surface.attachment : undefined;
      if (!attachment && (files.projectName === null || !files.workspaceRoot)) return null;
      return (
        <RegisteredSidePanel
          id="files"
          openInShortcutEnabled={visible && props.activeSurfaceId === surface.id}
          key={`${props.environmentId}:${
            attachment ? `attachment:${attachment.id}` : files.workspaceRoot
          }`}
          cwd={files.workspaceRoot ?? ""}
          projectName={files.projectName ?? ""}
          availableEditors={files.availableEditors}
          relativePath={surface.kind === "file" ? surface.relativePath : null}
          {...(attachment ? { attachment } : {})}
          revealLine={surface.kind === "file" ? (surface.revealLine ?? null) : null}
          revealRequestId={surface.kind === "file" ? surface.revealRequestId : 0}
          onNavigateFolder={(relativePath, folderTrail, keepSource) =>
            useRightPanelStore
              .getState()
              .navigateFolder(threadRef, surface.id, relativePath, folderTrail, keepSource)
          }
          folderTrail={surface.folderTrail}
          onPendingChange={files.onPendingChange}
          selectedFilePending={surface.kind === "file" && files.pendingSurfaceIds.has(surface.id)}
        />
      );
    }
  }
}
