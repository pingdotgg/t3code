import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, CommandId, type ScopedThreadRef } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { DialogPanel, DialogFooter } from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { gitEnvironment } from "~/state/git";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";
import { useEnvironmentScope } from "~/state/session";
import { stackedThreadToast, toastManager } from "./ui/toast";

export function CommitWorkflowForm(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly hasChanges: boolean;
  readonly isDefaultRef: boolean;
  readonly branch: string | null;
  readonly filePaths?: ReadonlyArray<string>;
  readonly fileSelection?: ReactNode;
  readonly controls?: ReactNode;
  readonly scope: "working_tree" | "branch";
  readonly onClose: () => void;
}) {
  const canStart = useAtomValue(
    gitEnvironment.startCommitWorkflow.permissionAtom(props.threadRef.environmentId),
  );
  const start = useAtomCommand(gitEnvironment.startCommitWorkflow, { reportFailure: false });
  const canOperateThread = useEnvironmentScope(
    props.threadRef.environmentId,
    AuthOrchestrationOperateScope,
  );
  const scope = props.scope;
  const [baseRef, setBaseRef] = useState("");
  const [instructions, setInstructions] = useState("");
  const submitted = useRef(false);
  const unavailable =
    scope === "working_tree"
      ? !props.hasChanges || props.filePaths?.length === 0
      : props.hasChanges || props.isDefaultRef || props.branch === null;

  const submit = (featureBranch = false) => {
    if (
      !canStart ||
      unavailable ||
      submitted.current ||
      (featureBranch && (!canOperateThread || scope !== "working_tree"))
    )
      return;
    const payload = {
      threadId: props.threadRef.threadId,
      cwd: props.cwd,
      expectedBranch: props.branch,
      scope:
        scope === "branch"
          ? { type: "branch" as const, ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}) }
          : {
              type: featureBranch
                ? ("working_tree_new_branch" as const)
                : ("working_tree" as const),
              ...(props.filePaths ? { filePaths: props.filePaths } : {}),
            },
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
    };
    submitted.current = true;
    const completion = start({
      environmentId: props.threadRef.environmentId,
      input: { ...payload, commandId: CommandId.make(randomUUID()) },
    });
    props.onClose();
    void completion.then((result) => {
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Commit workflow failed",
            description: cause instanceof Error ? cause.message : "Could not split commits.",
            data: { threadRef: props.threadRef },
          }),
        );
        return;
      }
      toastManager.add({
        type: "info",
        title: "Commit workflow finished",
        description: result.value.summary.split("\n")[0],
        data: {
          threadRef: props.threadRef,
          expandableContent: (
            <pre className="whitespace-pre-wrap break-words text-sm">{result.value.summary}</pre>
          ),
          expandableLabels: { expand: "Show result", collapse: "Hide result" },
        },
      });
    });
  };

  return (
    <>
      <DialogPanel>
        {props.controls}
        <div className="space-y-4">
          <p className="text-sm">Branch: {props.branch ?? "(detached HEAD)"}</p>
          {scope === "working_tree" ? (
            props.fileSelection
          ) : (
            <label className="block space-y-2 text-sm">
              <span>Base branch (optional)</span>
              <Input
                value={baseRef}
                onChange={(event) => setBaseRef(event.target.value)}
                placeholder="Repository default branch"
                maxLength={256}
              />
            </label>
          )}
          {scope === "branch" &&
            (props.hasChanges || props.isDefaultRef || props.branch === null) && (
              <p className="text-sm text-warning">
                Use a feature branch with a clean working tree to rebuild existing commits.
              </p>
            )}
          {scope === "working_tree" && props.branch === null && (
            <p className="text-sm text-muted-foreground">
              Commits will be created on detached HEAD. Any paused rebase will stay paused.
            </p>
          )}
          {scope === "working_tree" && props.isDefaultRef && (
            <p className="text-sm text-warning">This will commit directly to the default branch.</p>
          )}
          <label className="block space-y-2 text-sm">
            <span>Grouping instructions (optional)</span>
            <Textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              maxLength={10_000}
              placeholder="Independent helpers first, then core implementation and integration…"
            />
          </label>
          <p className="text-sm text-muted-foreground">
            The model groups changes and writes messages. T3 stages and commits them in this
            checkout, keeping a backup of the original history. Existing branch commits receive new
            IDs. Nothing is pushed.
          </p>
        </div>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" size="sm" onClick={props.onClose}>
          Cancel
        </Button>
        {scope === "working_tree" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={!canStart || !canOperateThread || unavailable}
            onClick={() => submit(true)}
          >
            Commit on new branch
          </Button>
        ) : null}
        <Button size="sm" disabled={!canStart || unavailable} onClick={() => submit()}>
          {scope === "branch" ? "Rebuild history" : "Create logical commits"}
        </Button>
      </DialogFooter>
    </>
  );
}
