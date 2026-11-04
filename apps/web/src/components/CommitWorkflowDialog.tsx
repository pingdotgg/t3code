import { useAtomValue } from "@effect/atom-react";
import { CommandId, type ScopedThreadRef } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Radio, RadioGroup } from "./ui/radio-group";
import { gitEnvironment } from "~/state/git";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "./ui/toast";

export function CommitWorkflowDialog(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly hasChanges: boolean;
  readonly isDefaultRef: boolean;
  readonly branch: string | null;
  readonly filePaths?: ReadonlyArray<string>;
  readonly fileSelection: ReactNode;
  readonly onClose: () => void;
}) {
  const canStart = useAtomValue(
    gitEnvironment.startCommitWorkflow.permissionAtom(props.threadRef.environmentId),
  );
  const start = useAtomCommand(gitEnvironment.startCommitWorkflow, { reportFailure: false });
  const [scope, setScope] = useState(props.hasChanges ? "working_tree" : "branch");
  const [baseRef, setBaseRef] = useState("");
  const [instructions, setInstructions] = useState("");
  const submitted = useRef(false);
  const unavailable =
    scope === "working_tree"
      ? !props.hasChanges || props.filePaths?.length === 0
      : props.hasChanges || props.isDefaultRef;

  const submit = () => {
    if (!canStart || unavailable || submitted.current || !props.branch) return;
    const payload = {
      threadId: props.threadRef.threadId,
      cwd: props.cwd,
      expectedBranch: props.branch,
      scope:
        scope === "branch"
          ? { type: "branch" as const, ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}) }
          : {
              type: "working_tree" as const,
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
            title: "Commit splitting failed",
            description: cause instanceof Error ? cause.message : "Could not split commits.",
            data: { threadRef: props.threadRef },
          }),
        );
        return;
      }
      toastManager.add({
        type: "info",
        title: "Commit splitting finished",
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Split into logical commits</DialogTitle>
          <DialogDescription>
            Build a dependency-ordered commit sequence using your Source Control settings. This
            action checks intermediate states and preserves the final contents and a backup of the
            original history.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <RadioGroup
              aria-label="Changes to split"
              value={scope}
              onValueChange={(value) => setScope(String(value))}
            >
              <label className="flex items-center gap-2 text-sm">
                <Radio value="working_tree" />
                Uncommitted changes
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Radio value="branch" />
                Existing branch commits
              </label>
            </RadioGroup>
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
            {scope === "branch" && (props.hasChanges || props.isDefaultRef) && (
              <p className="text-sm text-warning">
                Use a feature branch with a clean working tree to rebuild existing commits.
              </p>
            )}
            {scope === "working_tree" && props.isDefaultRef && (
              <p className="text-sm text-warning">
                This will commit directly to the default branch.
              </p>
            )}
            <label className="block space-y-2 text-sm">
              <span>Additional instructions (optional)</span>
              <Textarea
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                maxLength={10_000}
                placeholder="Independent helpers first, then core implementation and integration…"
              />
            </label>
            <p className="text-sm text-muted-foreground">
              Runs independently without chat history. Existing branch commits will receive new IDs.
              Nothing is pushed.
            </p>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" size="sm" onClick={props.onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canStart || unavailable || !props.branch} onClick={submit}>
            Split into commits
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
