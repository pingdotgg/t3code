import { useGT } from "gt-react";
import { GitBranchIcon } from "lucide-react";
import type { ComposerGitRef } from "@t3tools/shared/composerContextReferences";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useDiffPanelStore } from "~/diffPanelStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { ContextChipPopover } from "./contextChipParts";
import { Button } from "./ui/button";

export function GitRefContextChip(props: {
  target: ComposerGitRef;
  label: string;
  source?: string;
  threadRef?: ScopedThreadRef | null;
  cwd?: string;
}) {
  const gt = useGT();
  const { target, threadRef } = props;
  const sameHost = threadRef?.environmentId === target.environmentId;
  const commit = target.worktreePath === null ? target.commitSha : null;
  return (
    <ContextChipPopover
      kind="git-ref"
      icon={<GitBranchIcon />}
      label={props.label}
      accessibleLabel={
        target.worktreePath ? gt("Worktree {name}", { name: props.label }) : target.ref
      }
      {...(props.source ? { copyMarkdown: props.source } : {})}
    >
      <div className="grid gap-1.5">
        <code className="wrap-anywhere text-xs">{target.ref}</code>
        <code className="wrap-anywhere text-xs text-muted-foreground">
          {target.worktreePath ?? target.cwd}
        </code>
        {commit && <code className="wrap-anywhere text-xs text-muted-foreground">{commit}</code>}
        {threadRef && sameHost && commit && props.cwd === target.cwd ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              useDiffPanelStore.getState().selectCommit(threadRef, commit);
              useRightPanelStore.getState().open(threadRef, "diff");
            }}
          >
            {gt("Open commit")}
          </Button>
        ) : null}
        {threadRef && sameHost && target.worktreePath && props.cwd === target.worktreePath ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => useRightPanelStore.getState().openFile(threadRef, ".")}
          >
            {gt("Open files")}
          </Button>
        ) : null}
      </div>
    </ContextChipPopover>
  );
}
