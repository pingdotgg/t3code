import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  isListedThreadLineage,
  type EnvironmentId,
  type ThreadId,
  type ThreadSpecialist,
} from "@t3tools/contracts";
import { UserRoundIcon } from "lucide-react";
import { useState } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

const KEY_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

function specialistFields(specialist: ThreadSpecialist | undefined) {
  return {
    key: specialist?.key ?? "",
    label: specialist?.label ?? "",
    instructions: specialist?.instructions ?? "",
  };
}

function editorKey(shell: EnvironmentThreadShell) {
  const specialist = shell.source.specialist;
  return [
    specialist?.key ?? "",
    specialist?.label ?? "",
    specialist?.instructions ?? "",
    shell.archivedAt ?? "",
  ].join("\0");
}

export function ThreadSpecialistPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const shell = useThreadShell(threadRef);
  if (shell === null || !isListedThreadLineage(shell.lineage)) return null;
  // Remount when the live binding changes so the draft resets without an effect.
  return <ThreadSpecialistEditor key={editorKey(shell)} shell={shell} {...props} />;
}

function ThreadSpecialistEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly shell: EnvironmentThreadShell;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const canOperate = readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const setSpecialist = useOrchestrationCommand(threadEnvironment.setSpecialist, {
    label: "thread specialist bind",
  });
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    label: "thread specialist stop",
    reportFailure: false,
  });
  const { archiveThread, unarchiveThread } = useThreadActions();
  const bound = props.shell.source.specialist;
  const [fields, setFields] = useState(() => specialistFields(bound));
  const [busy, setBusy] = useState(false);

  const archived = props.shell.archivedAt !== null;
  const dirty =
    fields.key !== (bound?.key ?? "") ||
    fields.label !== (bound?.label ?? "") ||
    fields.instructions !== (bound?.instructions ?? "");
  const keyValid = KEY_PATTERN.test(fields.key.trim());
  const labelValue = fields.label.trim() || fields.key.trim();
  const canSave =
    canOperate && !busy && keyValid && labelValue.length > 0 && (dirty || bound === undefined);

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    const specialist: ThreadSpecialist = {
      key: fields.key.trim(),
      label: labelValue,
      ...(fields.instructions.trim() === "" ? {} : { instructions: fields.instructions.trim() }),
    };
    const result = await setSpecialist({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, specialist },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not bind specialist", squashAtomCommandFailure(result));
    }
  };

  const clear = async () => {
    if (!canOperate || busy || bound === undefined) return;
    setBusy(true);
    const result = await setSpecialist({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, specialist: null },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not clear specialist", squashAtomCommandFailure(result));
    }
  };

  const stopAndArchive = async () => {
    if (!canOperate || busy || bound === undefined || archived) return;
    setBusy(true);
    if (!threadRuntimeCanArchive(props.shell.runtime)) {
      const stopped = await interruptTurn({
        environmentId: props.environmentId,
        input: { threadId: props.threadId },
      });
      if (stopped._tag === "Failure" && !isAtomCommandInterrupted(stopped)) {
        setBusy(false);
        reportFailure("Could not stop specialist", squashAtomCommandFailure(stopped));
        return;
      }
    }
    const archivedResult = await archiveThread(threadRef);
    setBusy(false);
    if (archivedResult._tag === "Failure" && !isAtomCommandInterrupted(archivedResult)) {
      reportFailure("Could not archive specialist", squashAtomCommandFailure(archivedResult));
    }
  };

  const restore = async () => {
    if (!canOperate || busy || bound === undefined || !archived) return;
    setBusy(true);
    const result = await unarchiveThread(threadRef);
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not restore specialist", squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-specialist-heading"
      title="Specialist"
      data-thread-specialist-panel
    >
      <div className={cn("flex flex-col gap-2 pb-1", THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS)}>
        <div className="flex items-center gap-2 text-2xs text-muted-foreground">
          <UserRoundIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span>
            {bound === undefined
              ? "Bind a durable role to this thread. Agents resume it by key."
              : archived
                ? `Archived @${bound.key}. Restore to reopen, or clear the binding.`
                : `@${bound.key} · ${bound.label}`}
          </span>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-muted-foreground">Key</span>
          <Input
            size="sm"
            font="mono"
            nativeInput
            value={fields.key}
            placeholder="dev-ui"
            spellCheck={false}
            autoComplete="off"
            disabled={!canOperate || busy || archived}
            aria-invalid={fields.key.length > 0 && !keyValid}
            onChange={(event) => setFields((current) => ({ ...current, key: event.target.value }))}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-muted-foreground">Label</span>
          <Input
            size="sm"
            nativeInput
            value={fields.label}
            placeholder={fields.key.trim() || "Display name"}
            disabled={!canOperate || busy || archived}
            onChange={(event) =>
              setFields((current) => ({ ...current, label: event.target.value }))
            }
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-muted-foreground">Role brief</span>
          <Textarea
            size="sm"
            rows={3}
            value={fields.instructions}
            placeholder="What this specialist owns…"
            disabled={!canOperate || busy || archived}
            onChange={(event) =>
              setFields((current) => ({ ...current, instructions: event.target.value }))
            }
          />
        </label>

        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <ThreadDetailsControl
            size="xs"
            variant="outline"
            part="meta"
            disabled={!canSave}
            onClick={() => void save()}
          >
            {bound === undefined ? "Bind" : "Save"}
          </ThreadDetailsControl>
          {bound !== undefined ? (
            <ThreadDetailsControl
              size="xs"
              variant="ghost"
              part="meta"
              disabled={!canOperate || busy}
              onClick={() => void clear()}
            >
              Clear
            </ThreadDetailsControl>
          ) : null}
          {bound !== undefined && !archived ? (
            <ThreadDetailsControl
              size="xs"
              variant="ghost"
              part="meta"
              tone="muted"
              disabled={!canOperate || busy}
              onClick={() => void stopAndArchive()}
            >
              Stop & archive
            </ThreadDetailsControl>
          ) : null}
          {bound !== undefined && archived ? (
            <ThreadDetailsControl
              size="xs"
              variant="outline"
              part="meta"
              disabled={!canOperate || busy}
              onClick={() => void restore()}
            >
              Restore
            </ThreadDetailsControl>
          ) : null}
        </div>
      </div>
    </ThreadDetailsSection>
  );
}
