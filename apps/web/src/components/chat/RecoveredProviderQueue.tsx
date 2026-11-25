import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useRef, useState } from "react";
import { useComposerDraftStore } from "../../composerDraftStore";
import { randomUUID } from "../../lib/utils";
import { assetEnvironment } from "../../state/assets";
import { readPreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { prepareRevertedMessageAttachments } from "../ChatView.logic";
import { Button } from "../ui/button";

export function RecoveredProviderQueue(props: {
  readonly item: Extract<OrchestrationV2TurnItem, { type: "system_notice" }>;
  readonly environmentId: EnvironmentId;
  readonly canRestore: boolean;
}) {
  const gt = useGT();
  const { item, environmentId } = props;
  const [status, setStatus] = useState<"idle" | "restoring" | "restored">("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  const queue = item.recoveredQueue;
  if (!queue) return null;
  const text = queue.entries
    .map((entry) => entry.text)
    .filter(Boolean)
    .join("\n\n");
  const attachments = queue.entries.flatMap((entry) => entry.attachments);
  const restore = async () => {
    if (busy.current || status !== "idle") return;
    busy.current = true;
    setStatus("restoring");
    setError(null);
    try {
      const connection = readPreparedConnection(environmentId);
      if (!connection) throw new Error(gt("The environment is not connected."));
      const files = await prepareRevertedMessageAttachments({
        message: { attachments },
        environmentId,
        httpBaseUrl: connection.httpBaseUrl,
        createAssetUrl,
      });
      const draftTarget = scopeThreadRef(environmentId, item.threadId);
      const store = useComposerDraftStore.getState();
      const draft = store.getComposerDraft(draftTarget);
      if (
        (draft?.images.length ?? 0) + (draft?.files.length ?? 0) + files.length >
        PROVIDER_SEND_TURN_MAX_ATTACHMENTS
      ) {
        throw new Error(gt("Make room for the recovered attachments in the composer."));
      }
      if (text) store.setPrompt(draftTarget, [draft?.prompt, text].filter(Boolean).join("\n\n"));
      store.addImages(
        draftTarget,
        files.map((file) => ({
          type: "image",
          id: randomUUID(),
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          file,
          previewUrl: URL.createObjectURL(file),
        })),
        { allowDuplicates: true },
      );
      setStatus("restored");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Could not restore the queue."));
      setStatus("idle");
    } finally {
      busy.current = false;
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-card p-3 text-sm">
      <p className="font-medium">
        <T>Oh My Pi queue recovered</T>
      </p>
      {text ? (
        <p className="line-clamp-4 wrap-anywhere whitespace-pre-wrap text-muted-foreground">
          {text}
        </p>
      ) : null}
      {queue.truncated ? (
        <p className="text-muted-foreground">
          <T>Some queued messages could not be recovered.</T>
        </p>
      ) : null}
      {queue.imagesDropped ? (
        <p className="text-muted-foreground">
          <T>Some queued images could not be recovered.</T>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {props.canRestore && (text || attachments.length > 0) ? (
        <Button
          className="self-start"
          size="sm"
          variant="outline"
          disabled={status !== "idle"}
          onClick={() => void restore()}
        >
          {status === "restored" ? (
            <T>Restored to draft</T>
          ) : status === "restoring" ? (
            <T>Restoring…</T>
          ) : (
            <T>Restore to draft</T>
          )}
        </Button>
      ) : null}
    </div>
  );
}
