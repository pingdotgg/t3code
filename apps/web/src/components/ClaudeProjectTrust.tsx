import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthTerminalOperateScope,
  type ClaudeProjectCommand,
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

const SOURCE_FILES: Record<ClaudeProjectCommand["source"], string> = {
  project: ".claude/settings.json",
  local: ".claude/settings.local.json",
  mcp: ".mcp.json",
};

const KIND_LABELS: Record<ClaudeProjectCommand["kind"], string> = {
  hook: msg("Hook", { $context: "a Claude Code hook: a command that runs on an event" }),
  helper: msg("Helper command"),
  mcp: msg("MCP server"),
  env: msg("Environment variable"),
};

/** Everything a folder's Claude Code configuration would run, as the files hold it, grouped by file. */
export function ClaudeProjectCommandList({
  commands,
}: {
  commands: ReadonlyArray<ClaudeProjectCommand>;
}) {
  const m = useMessages();
  return (
    <div className="flex min-w-0 flex-col gap-3 text-left">
      {(["project", "local", "mcp"] as const).map((source) => {
        const declared = commands.filter((command) => command.source === source);
        if (declared.length === 0) return null;
        return (
          <div key={source} className="flex min-w-0 flex-col gap-1.5">
            <code className="text-xs text-muted-foreground">{SOURCE_FILES[source]}</code>
            {declared.map((command, index) => (
              // Entries have no identity of their own and the list is replaced as a whole.
              // oxlint-disable-next-line react/no-array-index-key
              <div key={index} className="flex min-w-0 flex-col gap-1">
                <span className="font-medium text-xs">
                  {command.event}
                  {command.matcher === undefined ? null : (
                    <span className="font-normal text-muted-foreground"> · {command.matcher}</span>
                  )}
                  <span className="font-normal text-muted-foreground">
                    {" · "}
                    {m(KIND_LABELS[command.kind])}
                  </span>
                </span>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
                  {command.detail}
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
 * Whether a project's Claude Code settings are trusted, what its folder, or the folder of one of
 * its threads, would run, and the trust a person gives or withdraws.
 */
export function useClaudeProjectTrust(
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
  const canTrust = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const query = useEnvironmentQuery(
    access.canReadFiles && target !== null
      ? filesystemEnvironment.claudeProjectTrust({
          environmentId: target.environmentId,
          input: {
            projectId: target.projectId,
            ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
          },
        })
      : null,
  );
  const setTrust = useAtomCommand(filesystemEnvironment.setClaudeProjectTrust, {
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);

  const save = async (trusted: boolean) => {
    if (target === null) return false;
    setSaving(true);
    const result = await setTrust({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, trusted },
    });
    setSaving(false);
    query.refresh();
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: trusted ? gt("Could not trust the project") : gt("Could not revoke the trust"),
        ...(error instanceof Error ? { description: error.message } : {}),
      });
      return false;
    }
    return true;
  };

  return { query, canTrust, saving, save };
}
