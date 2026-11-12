import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type GitStackManageInput,
  type ThreadId,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import { scopeThreadRef, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { getStackBranchSwitchDisabledReason } from "@t3tools/client-runtime/state/vcs";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import type { EnvMode } from "./BranchToolbar.logic";
import { vcsEnvironment, vcsActionManager } from "~/state/vcs";
import { ThreadDetailsSection } from "./chat/ThreadDetailsSection";
import { gitEnvironment } from "~/state/git";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { StackBranchPicker } from "./StackBranchPicker";

export function BranchStackControl({
  environmentId,
  cwd,
  threadId,
  projectId,
  worktreePath,
  isServerThread,
  draftId,
  envMode,
  onBranchChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly isServerThread: boolean;
  readonly draftId?: DraftId;
  readonly envMode: EnvMode;
  readonly onBranchChange?: ((branch: string | null) => void) | undefined;
}) {
  const query = useEnvironmentQuery(gitEnvironment.stackStatus({ environmentId, input: { cwd } }));
  const manage = useAtomCommand(gitEnvironment.manageStack, { reportFailure: true });
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: true });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: true });
  const canSwitchRef = useAtomValue(vcsEnvironment.switchRef.permissionAtom(environmentId));
  const canUpdateMetadata = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const checkout = useEnvironmentQuery(vcsEnvironment.status({ environmentId, input: { cwd } }));
  const [switching, setSwitching] = useState(false);
  const switchBranch = async (branch: string) => {
    if (switching) return;
    setSwitching(true);
    try {
      const result = await switchRef({
        environmentId,
        input: { cwd, refName: branch, requireClean: true },
      });
      if (result._tag !== "Success") return;
      const nextBranch = result.value.refName ?? branch;
      if (isServerThread) {
        await updateMetadata({
          environmentId,
          input: { threadId, branch: nextBranch, worktreePath },
        });
      } else {
        useComposerDraftStore
          .getState()
          .setDraftThreadContext(draftId ?? scopeThreadRef(environmentId, threadId), {
            branch: nextBranch,
            worktreePath,
            envMode,
            environmentSelection: "manual",
            projectRef: scopeProjectRef(environmentId, projectId),
          });
      }
      onBranchChange?.(nextBranch);
    } finally {
      query.refresh();
      setSwitching(false);
    }
  };
  const permitted = useAtomValue(gitEnvironment.manageStack.permissionAtom(environmentId));
  const [adopting, setAdopting] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState("");
  const [includeLatestBase, setIncludeLatestBase] = useState(false);
  const workflow = useEnvironmentQuery(
    gitEnvironment.workflowProgress({ environmentId, input: { cwd } }),
  ).data;
  const actionState = useAtomValue(vcsActionManager.stateAtom({ environmentId, cwd }));
  const busy = switching || actionState.isRunning || workflow?.state === "running";
  const workflowState = workflow?.state;
  const workflowStartedAt = workflow?.startedAtMs;
  const refreshStack = query.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes server recovery controls when a workflow on any client settles.
  useEffect(() => {
    if (workflowStartedAt !== undefined && workflowState && workflowState !== "running")
      refreshStack();
  }, [workflowState, workflowStartedAt, refreshStack]);
  const status = query.data;
  const run = (action: GitStackManageInput["action"]) => {
    void manage({
      environmentId,
      input: {
        cwd,
        action,
        expectedBranch: status?.layers.find((layer) => layer.current)?.branch ?? null,
        ...(action === "adopt" || action === "edit"
          ? {
              base: base.trim(),
              branches,
            }
          : {}),
        ...(action === "update" ? { includeLatestBase } : {}),
      },
    }).then((result) => {
      if (result._tag === "Success") {
        setAdopting(false);
        query.refresh();
      }
    });
  };
  if (!status)
    return (
      <ThreadDetailsSection headingId="thread-details-stack-heading" title="Branch stack">
        <div className="px-2.5">
          {query.error ? (
            <p className="text-xs text-destructive">{query.error}</p>
          ) : (
            <Button size="xs" variant="ghost-muted" disabled>
              Adopt branch stack
            </Button>
          )}
        </div>
      </ThreadDetailsSection>
    );
  if (status.layers.length === 0 || (!status.managed && status.layers[0]?.branch === status.base))
    return null;
  return (
    <ThreadDetailsSection headingId="thread-details-stack-heading" title="Branch stack">
      <div className="space-y-2 px-2.5">
        {!status.baseIsDefault ? (
          <p className="text-xs text-muted-foreground">Base: {status.base}</p>
        ) : null}
        <ol aria-label="Stack layers" className="space-y-2 border-l border-border pl-3 text-xs">
          {status.layers.map((layer) => {
            const disabledReason = getStackBranchSwitchDisabledReason({
              layer,
              hasWorkingTreeChanges: checkout.data?.hasWorkingTreeChanges ?? null,
              canSwitch: canSwitchRef && (!isServerThread || canUpdateMetadata),
              busy,
              paused: status.operation !== null,
            });
            return (
              <li
                key={layer.branch}
                className="relative min-w-0"
                aria-current={layer.current ? "step" : undefined}
              >
                <span
                  aria-hidden
                  className={`absolute -left-[calc(--spacing(3)+3px)] top-1.5 size-1.5 rounded-full ${layer.current ? "bg-primary" : "bg-muted-foreground"}`}
                />
                <div className="flex min-w-0 items-baseline gap-2">
                  <Tooltip>
                    <TooltipTrigger render={<span className="min-w-0 flex-1" />}>
                      <button
                        type="button"
                        className={`block w-full truncate text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring rounded-sm ${layer.current ? "font-medium" : "text-muted-foreground"} ${disabledReason ? "cursor-default" : "cursor-pointer hover:text-foreground hover:underline"}`}
                        disabled={disabledReason !== null}
                        onClick={() => {
                          if (!disabledReason) void switchBranch(layer.branch);
                        }}
                        aria-label={`Switch to ${layer.branch}`}
                      >
                        {layer.branch}
                      </button>
                    </TooltipTrigger>
                    <TooltipPopup>
                      {layer.branch}
                      <br />
                      {disabledReason ?? "Switch to branch"}
                    </TooltipPopup>
                  </Tooltip>
                  {layer.pullRequest ? (
                    <a
                      href={layer.pullRequest.url}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 text-muted-foreground underline underline-offset-2"
                    >
                      #{layer.pullRequest.number}
                    </a>
                  ) : null}
                </div>
                {layer.hasChanges ? (
                  <p className="text-muted-foreground">Uncommitted changes</p>
                ) : null}
                {layer.needsRestack ? <p className="text-warning">Needs restacking</p> : null}
              </li>
            );
          })}
        </ol>
        {status.managed ? (
          <>
            {status.operation ? (
              <>
                <p className="break-words text-xs text-warning">
                  Stack update paused at {status.operation.branch} ({status.operation.phase}).
                  {status.operation.phase === "rebase"
                    ? ` Resolve and stage conflicts in ${status.operation.cwd} before continuing.`
                    : status.operation.phase === "hooks"
                      ? " Continue retries unfinished post-push hooks. The branches are already published."
                      : " Continue retries publishing. Abort restores local branches; completed remote pushes remain."}
                </p>
                <div className="flex gap-2">
                  <Button size="xs" disabled={!permitted || busy} onClick={() => run("continue")}>
                    Continue
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!permitted || busy}
                    onClick={() => run("abort")}
                  >
                    Abort
                  </Button>
                </div>
              </>
            ) : (
              <>
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={includeLatestBase}
                    onCheckedChange={setIncludeLatestBase}
                    disabled={busy}
                  />
                  Include latest {status.base}
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!permitted || busy}
                    onClick={() => run("update")}
                  >
                    Update stack
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={!permitted || busy}
                    onClick={() => {
                      setBranches(status.layers.map((layer) => layer.branch));
                      setBase(status.base);
                      setAdopting(true);
                    }}
                  >
                    Edit layers
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={!permitted || busy}
                    onClick={() => run("untrack")}
                  >
                    Untrack
                  </Button>
                </div>
              </>
            )}
          </>
        ) : (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!permitted || busy}
            onClick={() => {
              setBranches(status.layers.map((layer) => layer.branch));
              setBase(status.base);
              setAdopting(true);
            }}
          >
            Adopt branch stack
          </Button>
        )}
        <Dialog open={adopting} onOpenChange={setAdopting}>
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>
                {status.managed ? "Edit stack layers" : "Adopt branch stack"}
              </DialogTitle>
              <DialogDescription>
                {status.managed
                  ? "Choose existing branches in base-to-tip order. Editing the hierarchy preserves commits; branches must already follow this order."
                  : "T3 will maintain these branches and their existing reviews. Adoption preserves branches and commits."}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="space-y-4">
                <div className="space-y-2 text-sm">
                  <p>Base branch</p>
                  <StackBranchPicker
                    environmentId={environmentId}
                    cwd={cwd}
                    value={base}
                    excluded={branches}
                    label="Base branch"
                    onChange={setBase}
                  />
                </div>
                <ol
                  aria-label="Stack hierarchy, base to tip"
                  className="space-y-3 border-l border-border pl-4"
                >
                  {branches.map((branch, index) => (
                    <li key={branch} className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Layer {index + 1}
                        {index === branches.length - 1 ? " · tip" : ""}
                      </p>
                      <StackBranchPicker
                        environmentId={environmentId}
                        cwd={cwd}
                        value={branch}
                        excluded={[base, ...branches.filter((_, i) => i !== index)]}
                        label={`Branch for layer ${index + 1}`}
                        onChange={(name) =>
                          setBranches(branches.map((value, i) => (i === index ? name : value)))
                        }
                      />
                      <div className="flex gap-2">
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          disabled={index === 0}
                          aria-label={`Move layer ${index + 1} toward base`}
                          onClick={() =>
                            setBranches(
                              branches.toSpliced(index - 1, 2, branch, branches[index - 1]!),
                            )
                          }
                        >
                          Move up
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          disabled={index === branches.length - 1}
                          aria-label={`Move layer ${index + 1} toward tip`}
                          onClick={() =>
                            setBranches(branches.toSpliced(index, 2, branches[index + 1]!, branch))
                          }
                        >
                          Move down
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          aria-label={`Remove layer ${index + 1}`}
                          onClick={() => setBranches(branches.filter((_, i) => i !== index))}
                        >
                          Remove
                        </Button>
                      </div>
                    </li>
                  ))}
                </ol>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={branches.includes("")}
                  onClick={() => setBranches([...branches, ""])}
                >
                  Add branch
                </Button>
                <p className="text-xs text-muted-foreground">
                  Push destination: {status.remote}. After adoption, use T3 to maintain this stack
                  instead of another stack manager.
                </p>
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAdopting(false)}>
                Cancel
              </Button>
              <Button
                disabled={
                  !base.trim() ||
                  branches.length === 0 ||
                  branches.some((branch) => !branch) ||
                  busy ||
                  !permitted
                }
                onClick={() => run(status.managed ? "edit" : "adopt")}
              >
                {status.managed ? "Save layers" : "Adopt stack"}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      </div>
    </ThreadDetailsSection>
  );
}
