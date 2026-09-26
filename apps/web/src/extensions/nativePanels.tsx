import { SelectedApiPresentation, type PresentationRequest } from "./SelectedApiPresentation";
import type { ReactNode } from "react";
import type { ViewContext, ViewRecord } from "@t3tools/extension-sdk/contracts";
import { useRightPanelStore, type RightPanelSurface } from "../rightPanelStore";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { WorkspaceExtensionSurface } from "./workspaceRegistry";
import { isElectron } from "../env";
import { useThreadShell } from "../state/entities";
import { useComposerDraftStore } from "../composerDraftStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { createNativeSurfaceBridge } from "./nativeBridge";
import { createBrowserExtension, type BrowserBindings } from "./browser/browserExtension";
import { createFilesExtension, filesViewRecord, type FilesBindings } from "./files/filesExtension";
import { createTerminalExtension, type TerminalBindings } from "./terminal";
import type { PersistentThreadTerminalDrawerProps } from "./terminal/PersistentThreadTerminal";
import { createDiffExtension, type DiffBindings } from "./diff";
import { createAgentsExtension, type AgentsBindings } from "./agents";
import type { VersionControlBindings } from "./version-control";
import { versionControlBridge } from "./nativeVersionControl";

const browser = createNativeSurfaceBridge(createBrowserExtension);
const files = createNativeSurfaceBridge(createFilesExtension);
const terminal = createNativeSurfaceBridge(createTerminalExtension);
const diff = createNativeSurfaceBridge(createDiffExtension);
const agents = createNativeSurfaceBridge(createAgentsExtension);

export interface NativePanelBindings {
  readonly browser: BrowserBindings | null;
  readonly files: FilesBindings | null;
  readonly terminal: TerminalBindings | null;
  readonly diff: DiffBindings;
  readonly agents: AgentsBindings;
  readonly versionControl: VersionControlBindings | null;
}
interface PanelProps {
  /** Devices are host-rendered by the chat view; no extension family owns them. */
  readonly surface: Exclude<RightPanelSurface, { kind: "device" }>;
  readonly threadRef: ScopedThreadRef;
  readonly context: ViewContext;
  readonly visible: boolean;
  readonly bindings: NativePanelBindings;
}
function entry<Bindings>(
  bridge: ReturnType<typeof createNativeSurfaceBridge<Bindings>>,
  select: (bindings: NativePanelBindings) => Bindings | null,
  makeRecord?: (bindings: Bindings, context: ViewContext) => ViewRecord,
  presentation?: (bindings: Bindings) => PresentationRequest | null,
) {
  const descriptor = bridge.extension.manifest.surfaces[0]!;
  return {
    descriptor,
    render({ bindings, context, visible }: PanelProps): ReactNode {
      const selected = select(bindings);
      if (selected === null) return null;
      const fallback = (
        <bridge.Surface
          bindings={selected}
          visible={visible}
          retainHiddenPresentation
          record={
            makeRecord?.(selected, context) ?? {
              version: 1,
              surfaceId: descriptor.id,
              context,
              placement: "side-panel",
              stateVersion: descriptor.stateVersion,
              restoreState: null,
              fallback: descriptor.title + " unavailable",
            }
          }
        />
      );
      const request = presentation?.(selected);
      return request ? (
        <SelectedApiPresentation
          request={request}
          context={context}
          visible={visible}
          fallback={fallback}
        />
      ) : (
        fallback
      );
    },
  };
}
const filesEntry = entry(
  files,
  (bindings) => bindings.files,
  filesViewRecord,
  (bindings) =>
    bindings.surface.kind === "file" && bindings.surface.attachment
      ? null
      : {
          apiId: "t3.file/presentation",
          method: "open",
          ...(bindings.surface.kind === "file"
            ? {
                navigationId:
                  bindings.surface.presentationRequestId ??
                  "legacy:" + bindings.surface.revealRequestId,
              }
            : {}),
          input: {
            relativePath: bindings.surface.kind === "file" ? bindings.surface.relativePath : "",
          },
        },
);
/** Legacy resource records remain domain-owned; the shell resolves registered presentations. */
export const nativePanelRegistry = {
  preview: entry(browser, (bindings) => bindings.browser),
  terminal: entry(terminal, (bindings) => bindings.terminal),
  files: filesEntry,
  file: filesEntry,
  diff: entry(diff, (bindings) => bindings.diff),
  agents: entry(agents, (bindings) => bindings.agents),
  "pull-request": entry(versionControlBridge, (bindings) => bindings.versionControl),
  "pull-requests": entry(versionControlBridge, (bindings) => bindings.versionControl),
} satisfies Record<
  Exclude<RightPanelSurface["kind"], "extension" | "device">,
  { render(props: PanelProps): ReactNode }
>;

export function NativeRightPanel(props: PanelProps) {
  if (props.surface.kind === "extension") {
    if (props.surface.record.placement !== "side-panel") {
      return (
        <div role="status">
          {props.surface.record.fallback} — Placement {props.surface.record.placement} is
          unavailable here.
        </div>
      );
    }
    return (
      <WorkspaceExtensionSurface
        key={JSON.stringify([
          props.threadRef.environmentId,
          props.threadRef.threadId,
          props.surface.id,
          props.surface.viewerGeneration,
        ])}
        record={props.surface.record}
        visible={props.visible}
        onRecordChange={(record) =>
          useRightPanelStore
            .getState()
            .updateExtensionRecord(
              props.threadRef,
              record,
              props.surface.kind === "extension" ? props.surface.viewerGeneration : undefined,
            )
        }
      />
    );
  }
  return nativePanelRegistry[props.surface.kind].render(props);
}

/** Each retained dock resolves its own thread; a foreground project must never retarget it. */
export function NativeTerminalDock(props: PersistentThreadTerminalDrawerProps) {
  const shell = useThreadShell(props.threadRef);
  const draft = useComposerDraftStore((store) => store.getDraftThreadByRef(props.threadRef));
  const projectId = shell?.projectId ?? draft?.projectId;
  const terminalOpen = useTerminalUiStateStore(
    (state) =>
      selectThreadTerminalUiState(state.terminalUiStateByThreadKey, props.threadRef).terminalOpen,
  );
  if (!projectId) return null;
  const record: ViewRecord = {
    version: 1,
    surfaceId: "t3.terminal/view",
    placement: "bottom-dock",
    stateVersion: 1,
    restoreState: null,
    fallback: "Terminal unavailable",
    context: {
      client: isElectron ? "desktop" : "web",
      resource: {
        namespace: "t3.workspace",
        id: "terminal-dock",
        projectId,
        environmentId: props.threadRef.environmentId,
        threadId: props.threadRef.threadId,
      },
    },
  };
  return (
    <terminal.Surface
      record={record}
      visible={props.active && terminalOpen}
      retainHiddenPresentation
      bindings={{ placement: "bottom-dock", props }}
    />
  );
}
