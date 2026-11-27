import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { BotFileKind, BotFilesReadResult, ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState, type FormEvent } from "react";

import { useThreadGroupingActions } from "~/hooks/useThreadGroupingActions";
import { m } from "~/i18n/messages";
import { botFilesEnvironment } from "~/state/botFiles";
import { useQuietThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

const FILES: ReadonlyArray<BotFileKind> = ["notes", "preferences"];

function BotFilesForm(props: {
  threadRef: ScopedThreadRef;
  files: BotFilesReadResult;
  canWrite: boolean;
}) {
  const gt = useGT();
  const write = useAtomCommand(botFilesEnvironment.write, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    for (const file of FILES) {
      const contents = String(form.get(file) ?? "");
      if (contents === props.files[file]) continue;
      const result = await write({
        environmentId: props.threadRef.environmentId,
        input: { threadId: props.threadRef.threadId, file, contents },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: gt("Failed to save Bot notes"),
          description:
            thrownErrorMessage(squashAtomCommandFailure(result), m) ?? gt("An error occurred."),
        });
        break;
      }
    }
    setSaving(false);
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={save}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="bot-preferences">
          <T>Instructions</T>
        </Label>
        <Textarea
          id="bot-preferences"
          name="preferences"
          rows={4}
          size="sm"
          defaultValue={props.files.preferences}
          disabled={!props.canWrite}
          placeholder={gt("How you like the Bot to work.")}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="bot-notes">
          <T>Notes</T>
        </Label>
        <Textarea
          id="bot-notes"
          name="notes"
          rows={6}
          size="sm"
          defaultValue={props.files.notes}
          disabled={!props.canWrite}
          placeholder={gt("What the Bot keeps track of between turns.")}
        />
      </div>
      <Button type="submit" size="sm" disabled={!props.canWrite || saving} className="self-end">
        <T>Save</T>
      </Button>
    </form>
  );
}

/** A Bot's instructions, notes and crew muting, on its board. */
export function BotNotes(props: { threadRef: ScopedThreadRef }) {
  const thread = useQuietThreadShell(props.threadRef);
  const canWrite = useAtomValue(
    botFilesEnvironment.write.permissionAtom(props.threadRef.environmentId),
  );
  const { setMuteCrew } = useThreadGroupingActions();
  const files = useEnvironmentQuery(
    botFilesEnvironment.files({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId },
    }),
  );
  const botConfig = thread?.botConfig;
  if (botConfig == null) return null;
  return (
    <div className="flex flex-col gap-3 px-2.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="bot-mute-crew">
          <T>Mute crew noise</T>
        </Label>
        <Switch
          id="bot-mute-crew"
          size="sm"
          checked={botConfig.muteChildren}
          disabled={!canWrite}
          onCheckedChange={(checked) => void setMuteCrew(props.threadRef, checked)}
        />
      </div>
      {files.data === null ? (
        <p className="text-muted-foreground text-sm">{files.error ?? <T>Loading…</T>}</p>
      ) : (
        <BotFilesForm
          key={files.dataUpdatedAt}
          threadRef={props.threadRef}
          files={files.data}
          canWrite={canWrite}
        />
      )}
    </div>
  );
}
