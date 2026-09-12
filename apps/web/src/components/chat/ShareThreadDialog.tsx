import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ShareOptions, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { CopyIcon, ExternalLinkIcon, LinkIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { shareEnvironment } from "../../state/shares";
import { useAtomCommand } from "../../state/use-atom-command";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { Switch } from "../ui/switch";

const OPTIONS = [
  {
    key: "includeToolCalls",
    title: "Tool calls",
    description: "Tools the assistant used, including their inputs.",
  },
  {
    key: "includeToolResults",
    title: "Tool results",
    description: "Command output, file contents, and other results.",
  },
  { key: "includePlans", title: "Plans", description: "Proposed implementation plans." },
] as const;

export function ShareThreadDialog({
  environmentId,
  threadId,
  title,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  title: string;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<ShareOptions>({
    includeToolCalls: false,
    includeToolResults: false,
    includePlans: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const create = useAtomCommand(shareEnvironment.create, { reportFailure: false });
  const revoke = useAtomCommand(shareEnvironment.revoke, { reportFailure: false });
  const sharesResult = useAtomValue(shareEnvironment.list({ environmentId, input: { threadId } }));
  const shares = Option.getOrElse(AsyncResult.value(sharesResult), () => []);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  async function createLink() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await create({ environmentId, input: { threadId, options } });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not create a share link.");
        return;
      }
      setCreatedUrl(result.value.url);
    } finally {
      setBusy(false);
    }
  }

  async function revokeLink(code: string, url: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await revoke({ environmentId, input: { code, threadId } });
      if (result._tag === "Failure") {
        setError("Could not revoke this link. Please try again.");
        return;
      }
      if (createdUrl === url) setCreatedUrl(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="w-full overflow-y-auto sm:max-w-lg">
        <div className="p-6">
          <div className="mb-4 grid size-9 place-items-center rounded-lg border border-border bg-muted/30">
            <LinkIcon className="size-4 text-muted-foreground" />
          </div>
          <DialogTitle>Share this chat</DialogTitle>
          <DialogDescription className="mt-2">
            Create a read-only snapshot of "{title}".
          </DialogDescription>
          <div className="my-6 divide-y divide-border/60 border-y border-border/60">
            {OPTIONS.map(({ key, title: optionTitle, description }) => (
              <label
                key={key}
                className="flex cursor-pointer items-center justify-between gap-6 py-4"
              >
                <span>
                  <span className="block text-sm font-medium">{optionTitle}</span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    {description}
                  </span>
                </span>
                <Switch
                  checked={options[key]}
                  disabled={busy}
                  aria-label={optionTitle}
                  onCheckedChange={(checked) => {
                    setOptions((current) => ({ ...current, [key]: checked }));
                    setCreatedUrl(null);
                  }}
                />
              </label>
            ))}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            User and assistant messages are always included. Attached files and linked context are
            excluded. Anything written in messages remains, including quoted tool results or plans.
          </p>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            Anyone with the link and access to this server can read it while the server is running.
            Later messages will not change the snapshot.
          </p>
          {error && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          )}
          {createdUrl ? (
            <div className="mt-5 space-y-3">
              <input
                aria-label="Share link"
                value={createdUrl}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
                className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs"
              />
              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => copyToClipboard(createdUrl, undefined)}>
                  <CopyIcon />
                  {isCopied ? "Copied" : "Copy link"}
                </Button>
                <Button
                  variant="outline"
                  render={<a href={createdUrl} target="_blank" rel="noopener noreferrer" />}
                >
                  <ExternalLinkIcon />
                  Open share
                </Button>
              </div>
            </div>
          ) : (
            <Button className="mt-5 w-full" disabled={busy} onClick={() => void createLink()}>
              <LinkIcon />
              {busy ? "Creating…" : "Create share link"}
            </Button>
          )}
          {shares.length > 0 && (
            <div className="mt-6 border-t border-border/60 pt-4">
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">Active links</h3>
              <div className="max-h-36 space-y-1 overflow-y-auto">
                {shares.map((share) => (
                  <div key={share.code} className="flex items-center justify-between gap-2 py-1">
                    <a
                      href={share.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-w-0 truncate text-xs underline underline-offset-4"
                    >
                      {new Date(share.createdAt).toLocaleString()}
                    </a>
                    <div className="flex">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Copy existing share link"
                        onClick={() => copyToClipboard(share.url, undefined)}
                      >
                        <CopyIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Revoke share link"
                        disabled={busy}
                        onClick={() => void revokeLink(share.code, share.url)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {AsyncResult.isFailure(sharesResult) && (
            <p role="alert" className="mt-4 text-xs text-destructive">
              Existing links could not be loaded. Reopen this dialog to retry.
            </p>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
