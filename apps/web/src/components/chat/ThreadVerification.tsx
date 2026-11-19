import { useState } from "react";
import { T, useGT } from "gt-react";
import { ClipboardCheckIcon, FileDiffIcon } from "lucide-react";
import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useThreadProjection } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import ChatMarkdown from "../ChatMarkdown";
import { ThreadDetailsChecks } from "./ThreadDetailsChecks";
import {
  buildVerificationRequest,
  selectVerificationReport,
  type VerificationCommandStatus,
} from "./threadVerification.logic";

export function ThreadVerification({
  threadRef,
  busy,
  workspaceRoot,
  onRequest,
  onOpenChanges,
}: {
  threadRef: ScopedThreadRef;
  busy: boolean;
  workspaceRoot: string | undefined;
  onRequest: (text: string) => Promise<void>;
  onOpenChanges?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm" className="shrink-0 [-webkit-app-region:no-drag]" />
        }
      >
        <ClipboardCheckIcon aria-hidden className="size-4" />
        <span className="hidden sm:inline">
          <T>Verify changes</T>
        </span>
        <span className="sr-only sm:hidden">
          <T>Verify changes</T>
        </span>
      </DialogTrigger>
      <DialogPopup className="flex max-h-[85dvh] w-full max-w-4xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            <T>Verification</T>
          </DialogTitle>
          <DialogDescription>
            <T>Review evidence before approving changes. Nothing runs until you request it.</T>
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <ConnectedVerificationPanel
            threadRef={threadRef}
            busy={busy}
            workspaceRoot={workspaceRoot}
            canRequest={canOperate}
            onRequest={onRequest}
            onOpenChanges={
              onOpenChanges
                ? () => {
                    setOpen(false);
                    onOpenChanges();
                  }
                : undefined
            }
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function ConnectedVerificationPanel(
  props: Omit<Parameters<typeof VerificationPanel>[0], "projection">,
) {
  const thread = useThreadProjection(props.threadRef);
  return <VerificationPanel {...props} projection={thread?.projection ?? null} />;
}

export function VerificationPanel({
  projection,
  threadRef,
  busy,
  canRequest,
  workspaceRoot,
  onRequest,
  onOpenChanges,
}: {
  projection: OrchestrationV2ThreadProjection | null;
  threadRef: ScopedThreadRef;
  busy: boolean;
  canRequest: boolean;
  workspaceRoot: string | undefined;
  onRequest: (text: string) => Promise<void>;
  onOpenChanges?: (() => void) | undefined;
}) {
  const gt = useGT();
  const [tests, setTests] = useState(true);
  const [browser, setBrowser] = useState(false);
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = selectVerificationReport(projection);
  const statusLabels: Record<VerificationCommandStatus, string> = {
    passed: gt("Passed"),
    failed: gt("Failed"),
    running: gt("Running"),
    interrupted: gt("Interrupted"),
    unconfirmed: gt("Unconfirmed"),
  };
  const activeReport =
    report &&
    report.runStatus !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(report.runStatus);
  const canRun = canRequest && !busy && !pending && !activeReport && (tests || browser);
  const request = async () => {
    if (!canRun) return;
    setPending(true);
    setError(null);
    try {
      await onRequest(
        buildVerificationRequest({ tests, browser, recording: browser && recording }),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : gt("Could not request verification."));
    }
    setPending(false);
  };
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-5 px-1 pb-1">
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <Label>
              <Checkbox checked={tests} onCheckedChange={(value) => setTests(value === true)} />
              <T>Tests and static checks</T>
            </Label>
            <Label>
              <Checkbox checked={browser} onCheckedChange={(value) => setBrowser(value === true)} />
              <T>Browser checks</T>
            </Label>
            <Label>
              <Checkbox
                checked={browser && recording}
                disabled={!browser}
                onCheckedChange={(value) => setRecording(value === true)}
              />
              <T>Record browser session</T>
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            <T>Uses this conversation's current agent and model. Recording is optional.</T>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void request()} disabled={!canRun} size="sm">
              <ClipboardCheckIcon aria-hidden className="size-4" />
              {pending ? gt("Requesting…") : gt("Run verification")}
            </Button>
            {onOpenChanges ? (
              <Button onClick={onOpenChanges} variant="outline" size="sm">
                <FileDiffIcon aria-hidden className="size-4" />
                <T>View diff</T>
              </Button>
            ) : null}
          </div>
          {busy || activeReport ? (
            <p role="status" className="text-xs text-muted-foreground">
              <T>Wait for the current run to finish. You can stop it from the conversation.</T>
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-error-foreground">
              {error}
            </p>
          ) : null}
        </div>
        {report ? (
          <section aria-label={gt("Latest verification")} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">
                <T>Latest verification</T>
              </h3>
              <span className="text-xs text-muted-foreground">
                {report.runStatus === "completed"
                  ? gt("Run completed")
                  : report.runStatus === "failed"
                    ? gt("Run failed")
                    : report.runStatus === "interrupted" ||
                        report.runStatus === "cancelled" ||
                        report.runStatus === "rolled_back"
                      ? gt("Run interrupted")
                      : gt("In progress")}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              <T>
                Command results are execution evidence, not a guarantee that every flow was tested.
              </T>
            </p>
            {report.commands.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                <T>No command evidence recorded yet.</T>
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {report.commands.map((command) => (
                  <li key={command.id} className="p-3">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <code className="min-w-0 break-all text-xs">{command.command}</code>
                      <span
                        className={
                          command.status === "failed"
                            ? "shrink-0 text-xs text-error-foreground"
                            : command.status === "passed"
                              ? "shrink-0 text-xs text-diff-addition-foreground"
                              : "shrink-0 text-xs text-muted-foreground"
                        }
                      >
                        {statusLabels[command.status]}
                      </span>
                    </div>
                    {command.exitCode !== null ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        <T>Exit code</T>: {command.exitCode}
                      </p>
                    ) : null}
                    {command.output ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                          <T>Command output</T>
                        </summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
                          {command.output.slice(-20000)}
                        </pre>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {report.answer ? (
              <div className="rounded-xl border border-border p-4">
                <h3 className="mb-3 text-sm font-medium">
                  <T>Agent report and evidence</T>
                </h3>
                <ChatMarkdown
                  text={report.answer.text}
                  cwd={workspaceRoot}
                  threadRef={threadRef}
                  environmentId={threadRef.environmentId}
                  isStreaming={report.answer.streaming}
                />
              </div>
            ) : null}
          </section>
        ) : (
          <p className="py-4 text-sm text-muted-foreground">
            <T>No verification requested for this conversation yet.</T>
          </p>
        )}
        <ThreadDetailsChecks threadRef={threadRef} />
      </div>
    </ScrollArea>
  );
}
