/**
 * Saying something back, from where the conversation is read. An issue and a pull request take a
 * comment the same way — the same box, the same locked-while-posting draft, the same word when the
 * host refuses — so only which host route it goes down, and what the box is called out loud, come
 * from the caller.
 */
import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { SendIcon } from "lucide-react";
import { useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

type CommentPayload = {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly projectId: ProjectId;
    readonly repository: string;
    readonly number: number;
    readonly body: string;
  };
};

export function CommentComposer({
  environmentId,
  detail,
  label,
  command,
  onCommented,
}: {
  environmentId: EnvironmentId;
  detail: {
    readonly projectId: ProjectId;
    readonly repository: string;
    readonly number: number;
  };
  /** What the box is for, spoken — it carries no visible text of its own. */
  label: string;
  /** The host route a comment goes down, which is the only thing the two surfaces disagree on. */
  command: AtomCommand<CommentPayload, unknown, unknown>;
  onCommented: () => void;
}) {
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const postComment = useAtomCommand(command, { reportFailure: false });

  const submit = async () => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || posting) return;
    setPosting(true);
    const result = await postComment({
      environmentId,
      input: {
        projectId: detail.projectId,
        repository: detail.repository,
        number: detail.number,
        body: trimmed,
      },
    });
    setPosting(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not post the comment" });
      return;
    }
    setBody("");
    onCommented();
  };

  return (
    <div className="mt-3 space-y-2">
      <Textarea
        // Locked while posting: the body is cleared on success, which would otherwise throw
        // away a new draft typed while the request was still in flight.
        disabled={posting}
        value={body}
        rows={3}
        placeholder="Leave a comment"
        aria-label={label}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex justify-end">
        <Button
          size="xs"
          variant="outline"
          disabled={body.trim().length === 0 || posting}
          onClick={() => void submit()}
        >
          <SendIcon className="size-3.5" />
          {posting ? "Posting..." : "Comment"}
        </Button>
      </div>
    </div>
  );
}
