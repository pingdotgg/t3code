import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createContext, type MouseEvent } from "react";

import type { ModelCameraView } from "@t3tools/client-runtime/model-preview/annotations";

export interface ComposerContextActions {
  environmentId: EnvironmentId | null;
  cwd?: string | undefined;
  projectId?: ProjectId | undefined;
  expandImage: (imageId: string) => void;
  expandVideo: (fileId: string) => void;
  openFile: (fileId: string) => void;
  openMention: (path: string) => void;
  /** Opens a 3D model at the camera its annotation saved. */
  openModelView: (path: string, view: ModelCameraView) => void;
  openPullRequest: (event: MouseEvent<HTMLElement>, url: string) => void;
}

export const ComposerContextActionsContext = createContext<ComposerContextActions>({
  environmentId: null,
  expandImage: () => {},
  expandVideo: () => {},
  openFile: () => {},
  openMention: () => {},
  openModelView: () => {},
  openPullRequest: () => {},
});
