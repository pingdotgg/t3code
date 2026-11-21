import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { MouseEvent } from "react";
import { createPluginContext } from "~/plugins/features";

export interface ComposerContextActions {
  environmentId: EnvironmentId | null;
  cwd?: string | undefined;
  projectId?: ProjectId | undefined;
  expandImage: (imageId: string) => void;
  expandVideo: (fileId: string) => void;
  openFile: (fileId: string) => void;
  openMention: (path: string) => void;
  openPullRequest: (event: MouseEvent<HTMLElement>, url: string) => void;
}

export const ComposerContextActionsContext = createPluginContext<ComposerContextActions>(
  "components/composerContextActions/ComposerContextActionsContext",
  {
    environmentId: null,
    expandImage: () => {},
    expandVideo: () => {},
    openFile: () => {},
    openMention: () => {},
    openPullRequest: () => {},
  },
);
