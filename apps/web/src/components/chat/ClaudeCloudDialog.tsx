import { T, useGT } from "gt-react";
import { useState } from "react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ClaudeSettings,
  type ServerProvider,
  type ServerSettings,
  type ExecutionEnvironmentPlatformOs,
} from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { claudeCloudCommand } from "./claudeCloudCommand";

const decodeClaudeSettings = Schema.decodeOption(ClaudeSettings);

export function ClaudeCloudDialog({
  provider,
  settings,
  platform,
  onRun,
}: {
  provider: ServerProvider;
  settings: ServerSettings;
  platform: ExecutionEnvironmentPlatformOs;
  onRun: (command: string) => Promise<void>;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [session, setSession] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const instance = settings.providerInstances[provider.instanceId];
  const config = decodeClaudeSettings(instance?.config ?? {});
  const binaryPath = Option.isSome(config) ? config.value.binaryPath : null;
  const submit = async () => {
    if (busy) return;
    if (binaryPath === null) {
      setError(gt("Invalid Claude instance settings. Check the provider configuration."));
      return;
    }
    if (instance?.environment?.some((variable) => typeof variable.value !== "string")) {
      setError(gt("Claude Cloud cannot use secret references in terminal environment variables."));
      return;
    }
    if (
      instance?.environment?.some(
        (variable) => variable.name === "T3CODE_TERMINAL_SHELL" && variable.value !== "/bin/sh",
      )
    ) {
      setError(
        gt(
          "Claude Cloud requires a POSIX shell. Remove the terminal shell override from this provider.",
        ),
      );
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const command = claudeCloudCommand({ binaryPath, platform, message, session });
      await onRun(command);
      setOpen(false);
      setMessage("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Could not open the cloud terminal."));
    }
    setBusy(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        <T>Claude Cloud</T>
      </DialogTrigger>
      <DialogPopup>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <T>Claude Cloud</T>
            </DialogTitle>
            <DialogDescription>
              <T>Start a new task or send a follow-up using the selected Claude account.</T>
            </DialogDescription>
          </DialogHeader>

          <DialogPanel>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                <T>
                  New tasks use the current repository. Claude may clone its pushed branch or upload
                  tracked files. The local conversation is not transferred.
                </T>
              </p>
              <div className="space-y-2">
                <label htmlFor="claude-cloud-session">
                  <T>Existing cloud session (optional)</T>
                </label>
                <Input
                  id="claude-cloud-session"
                  value={session}
                  onChange={(event) => setSession(event.target.value)}
                  placeholder={gt("Session ID or https://claude.ai/code/…")}
                  disabled={busy}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="claude-cloud-message">
                  {session.trim() ? gt("Follow-up message") : gt("Task")}
                </label>
                <Input
                  id="claude-cloud-message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  maxLength={4000}
                  disabled={busy}
                  required
                />
              </div>
              <p className="text-sm text-muted-foreground">
                <T>
                  The terminal shows the session link or delivery receipt. Check progress and
                  replies in Claude. Save the link before closing the terminal: closing deletes its
                  history but does not stop the cloud task.
                </T>
              </p>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={busy || !message.trim()}>
              {busy
                ? gt("Opening terminal…")
                : session.trim()
                  ? gt("Send follow-up")
                  : gt("Launch in cloud")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
