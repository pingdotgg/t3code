import type { ComponentProps } from "react";
import type { ThreadGitControls } from "./ThreadGitControls";
import type { ThreadInspectorMode } from "./thread-inspector-content-stack";

export interface ThreadHeaderProps {
  readonly title: string;
  readonly subtitle: string;
  readonly headerColor: string;
  readonly usesNativeHeaderGlass: boolean;
  readonly gitControls: ComponentProps<typeof ThreadGitControls>;
  readonly hasThreadCwd: boolean;
  readonly hasWorkspaceRoot: boolean;
  readonly fileInspectorSupported: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onToggleInspector: () => void;
  readonly onOpenGitInspector: () => void;
  readonly onOpenFilesInspector: () => void;
  readonly onReturnToThread?: () => void;
}
