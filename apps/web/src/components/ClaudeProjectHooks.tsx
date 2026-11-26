import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthTerminalOperateScope,
  type ClaudeProjectHook,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { filesystemEnvironment, useFilesystemReadAccess } from "../state/filesystem";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { toastManager } from "./ui/toast";

const SOURCE_FILES: Record<ClaudeProjectHook["source"], string> = {
  project: ".claude/settings.json",
  local: ".claude/settings.local.json",
};

const SOURCE_LABELS: Record<ClaudeProjectHook["source"], string> = {
  project: msg("From the project's settings"),
  local: msg("From your local settings for this project"),
};

/**
 * Every hook and helper command a folder's Claude Code settings declare, as the files hold them,
 * grouped by file.
 */
export function ClaudeProjectHookList({ hooks }: { hooks: ReadonlyArray<ClaudeProjectHook> }) {
  const gt = useGT();
  const m = useMessages();
  return (
    <div className="flex min-w-0 flex-col gap-3 text-left">
      {(["project", "local"] as const).map((source) => {
        const declared = hooks.filter((hook) => hook.source === source);
        if (declared.length === 0) return null;
        return (
          <div key={source} className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">
              {m(SOURCE_LABELS[source])} · <code>{SOURCE_FILES[source]}</code>
            </span>
            {declared.map((hook, index) => (
              // Hooks have no identity of their own and the list is replaced as a whole.
              // oxlint-disable-next-line react/no-array-index-key
              <div key={index} className="flex min-w-0 flex-col gap-1">
                <span className="font-medium text-xs">
                  {hook.event}
                  {hook.matcher === undefined ? null : (
                    <span className="font-normal text-muted-foreground"> · {hook.matcher}</span>
                  )}
                  {hook.kind === "helper" ? (
                    <span className="font-normal text-muted-foreground">
                      {" · "}
                      {gt("Helper command")}
                    </span>
                  ) : null}
                </span>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
                  {hook.detail}
                </pre>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The hooks a project's folder, or the folder of one of its threads, declares for Claude Code, and
 * the approval a person gives them. Approving sends the hash of the hooks on screen, so hooks that
 * changed since are not approved unseen.
 */
export function useClaudeProjectHooks(
  /** Null reads nothing. */
  target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly threadId?: ThreadId | undefined;
  } | null,
) {
  const gt = useGT();
  const environmentId = target?.environmentId ?? null;
  const access = useFilesystemReadAccess(environmentId);
  const canApprove = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const input =
    target === null
      ? null
      : {
          projectId: target.projectId,
          ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
        };
  const query = useEnvironmentQuery(
    access.canReadFiles && environmentId !== null && input !== null
      ? filesystemEnvironment.claudeProjectHooks({ environmentId, input })
      : null,
  );
  const approve = useAtomCommand(filesystemEnvironment.approveClaudeProjectHooks, {
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);

  const save = async (approved: boolean) => {
    const shown = query.data;
    if (shown === null || environmentId === null || input === null) return false;
    setSaving(true);
    const result = await approve({
      environmentId,
      input: { ...input, hooksHash: approved ? shown.hooksHash : null },
    });
    setSaving(false);
    query.refresh();
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: approved ? gt("Could not approve the hooks") : gt("Could not revoke the approval"),
        ...(error instanceof Error ? { description: error.message } : {}),
      });
      return false;
    }
    return true;
  };

  return { query, canApprove, saving, save };
}
