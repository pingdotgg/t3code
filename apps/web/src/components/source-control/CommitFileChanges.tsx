import type { VcsPanelCommitSummary, VcsPanelFileChange } from "@t3tools/contracts";
import { useEffect, useState, type ComponentProps } from "react";
import {
  isSourceControlPanelCommandInterrupted,
  type useSourceControlPanelApi,
} from "~/state/sourceControlPanel";
import { FileChangeList } from "./SourceControlPanelRows";

export function CommitFileChanges({
  commit,
  api,
  cwd,
  ...props
}: Omit<ComponentProps<typeof FileChangeList>, "files"> & {
  readonly commit: VcsPanelCommitSummary;
  readonly api: ReturnType<typeof useSourceControlPanelApi>;
  readonly cwd: string;
}) {
  const [files, setFiles] = useState<readonly VcsPanelFileChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!commit.filesDeferred || !api) return;
    let active = true;
    void api.vcs
      .commitFiles({ cwd, sha: commit.sha }, attempt > 0)
      .then((result) => {
        if (active) setFiles(result.files);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            isSourceControlPanelCommandInterrupted(cause)
              ? "Loading interrupted."
              : "Could not load commit files.",
          );
      });
    return () => {
      active = false;
    };
  }, [api, cwd, commit.sha, commit.filesDeferred, attempt]);
  if (!commit.filesDeferred) return <FileChangeList {...props} files={commit.files} />;
  if (error)
    return (
      <button
        className="px-3 py-1 text-xs"
        onClick={() => {
          setError(null);
          setFiles(null);
          setAttempt((value) => value + 1);
        }}
      >
        {error} Retry
      </button>
    );
  if (!files)
    return <div className="px-3 py-1 text-xs text-muted-foreground">Loading files...</div>;
  return <FileChangeList {...props} files={files} />;
}
