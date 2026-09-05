import type { EnvironmentId, PullRequestRef, ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon, LinkIcon, ReplyIcon, BotIcon } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useAtomCommand } from "~/state/use-atom-command";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { formatEnvironmentQueryError } from "~/state/query";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";

export const PullRequestCommentAgentContext = createContext<
  ((body: string, url: string | null) => void) | null
>(null);

export function PullRequestCommentActions({
  body,
  url,
  canReply,
  cwd,
  environmentId,
  threadRef,
  reference,
  onRefresh,
}: {
  body: string;
  url: string | null;
  canReply: boolean;
  cwd: string;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | null | undefined;
  reference: PullRequestRef;
  onRefresh: () => void;
}) {
  const addToAgent = useContext(PullRequestCommentAgentContext);
  const [replying, setReplying] = useState(false);
  const [saving, setSaving] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: () => toastManager.add({ type: "error", title: "Could not copy the comment link" }),
  });
  const comment = useAtomCommand(pullRequestEnvironment.comment, { reportFailure: false });
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1">
        {addToAgent ? (
          <Button size="xs" variant="ghost" onClick={() => addToAgent(body, url)}>
            <BotIcon aria-hidden className="size-3" />
            Add to agent
          </Button>
        ) : null}
        {canReply ? (
          <Button size="xs" variant="ghost" onClick={() => setReplying(true)}>
            <ReplyIcon aria-hidden className="size-3" />
            Quote reply
          </Button>
        ) : null}
        {url ? (
          <Button size="xs" variant="ghost" onClick={() => copyToClipboard(url)}>
            {isCopied ? (
              <CheckIcon aria-hidden className="size-3" />
            ) : (
              <LinkIcon aria-hidden className="size-3" />
            )}
            {isCopied ? "Copied" : "Copy link"}
          </Button>
        ) : null}
      </div>
      {replying ? (
        <PullRequestMarkdownEditor
          className="mt-2"
          value={
            body
              .split("\n")
              .map((line) => "> " + line)
              .join("\n") + "\n\n"
          }
          cwd={cwd}
          environmentId={environmentId}
          threadRef={threadRef ?? null}
          label="Quote reply"
          saveLabel="Post reply"
          saving={saving}
          onCancel={() => setReplying(false)}
          onSave={async (body) => {
            if (saving) return;
            setSaving(true);
            const result = await comment({ environmentId, input: { ...reference, body } });
            setSaving(false);
            if (result._tag === "Failure") {
              toastManager.add({
                type: "error",
                title: "Could not post the reply",
                description: formatEnvironmentQueryError(result.cause),
              });
              return;
            }
            setReplying(false);
            onRefresh();
          }}
        />
      ) : null}
    </div>
  );
}
