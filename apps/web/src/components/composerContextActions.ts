import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createContext, type MouseEvent } from "react";

export interface ComposerContextActions {
  environmentId: EnvironmentId | null;
  cwd?: string | undefined;
  projectId?: ProjectId | undefined;
  expandImage: (imageId: string) => void;
  expandVideo: (fileId: string) => void;
  openFile: (fileId: string) => void;
  retryFileUpload: (fileId: string) => void;
  canRetryFileUpload: boolean;
  openMention: (path: string) => void;
  openPullRequest: (event: MouseEvent<HTMLElement>, url: string) => void;
}

export const ComposerContextActionsContext = createContext<ComposerContextActions>({
  environmentId: null,
  expandImage: () => {},
  expandVideo: () => {},
  openFile: () => {},
  retryFileUpload: () => {},
  canRetryFileUpload: false,
  openMention: () => {},
  openPullRequest: () => {},
});
