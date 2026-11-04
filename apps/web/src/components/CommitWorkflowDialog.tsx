import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  type GitStartCommitWorkflowInput,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
  const cancel = useAtomCommand(gitEnvironment.cancelCommitWorkflow, { reportFailure: false });
  const inFlight = useRef<Parameters<typeof start>[0] | null>(null);
  useEffect(
    () => () => {
      const active = inFlight.current;
      if (active)
        void cancel({
          environmentId: active.environmentId,
          input: {
            commandId: active.input.commandId,
            cwd: active.input.cwd,
          },
        });
    },
    [cancel],
  );
  const [scope, setScope] = useState(props.hasChanges ? "working_tree" : "branch");
  const [baseRef, setBaseRef] = useState("");
  const [instructions, setInstructions] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const request = useRef<{ key: string; input: GitStartCommitWorkflowInput } | null>(null);
  const unavailable =
    scope === "working_tree"
      ? !props.hasChanges || props.filePaths?.length === 0
      : props.hasChanges || props.isDefaultRef;

  const submit = async () => {
    if (!canStart || unavailable || pending || !props.branch) return;
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
    const key = JSON.stringify(payload);
    if (request.current?.key !== key)
      request.current = {
        key,
        input: {
          ...payload,
          commandId: CommandId.make(randomUUID()),
        },
      };
    setPending(true);
    setError(null);
    const target = {
      environmentId: props.threadRef.environmentId,
      input: request.current.input,
    };
    inFlight.current = target;
    const result = await start(target);
    inFlight.current = null;
    setPending(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not split commits.");
      return;
    }
    setSummary(result.value.summary);
  };

  const cancelPending = async () => {
    if (!request.current || cancelling) return;
    setCancelling(true);
    const result = await cancel({
      environmentId: props.threadRef.environmentId,
      input: {
        commandId: request.current.input.commandId,
        cwd: props.cwd,
      },
    });
    setCancelling(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not cancel commit splitting.");
    } else request.current = null;
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
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
          {summary !== null ? (
            <pre className="whitespace-pre-wrap break-words text-sm">{summary}</pre>
          ) : (
            <div className="space-y-4">
              <RadioGroup
                aria-label="Changes to split"
                value={scope}
                onValueChange={(value) => setScope(String(value))}
                disabled={pending}
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
                    disabled={pending}
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
                  disabled={pending}
                  placeholder="Independent helpers first, then core implementation and integration…"
                />
              </label>
              <p className="text-sm text-muted-foreground">
                Runs independently without chat history. Existing branch commits will receive new
                IDs. Nothing is pushed.
              </p>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {pending && (
                <p role="status" className="text-sm text-muted-foreground">
                  Splitting and checking intermediate commits…
                </p>
              )}
            </div>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="outline"
            size="sm"
            disabled={cancelling}
            onClick={() => (pending ? void cancelPending() : props.onClose())}
          >
            {cancelling ? "Cancelling…" : summary !== null ? "Close" : "Cancel"}
          </Button>
          {summary === null && (
            <Button
              size="sm"
              disabled={!canStart || unavailable || pending || !props.branch}
              onClick={() => void submit()}
            >
              {pending ? "Splitting…" : "Split into commits"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
