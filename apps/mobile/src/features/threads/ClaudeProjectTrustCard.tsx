import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthTerminalOperateScope,
  type ClaudeProjectCommand,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { T, useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { m } from "../../i18n/messages";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

const SOURCE_FILES: Record<ClaudeProjectCommand["source"], string> = {
  project: ".claude/settings.json",
  local: ".claude/settings.local.json",
  mcp: ".mcp.json",
};

/**
 * Shown in a Claude thread below Full access in a project nobody trusted, whose folder would run
 * something: asks, shows what would run, and records the trust. `draft` reads the project's
 * folder, because the thread has none of its own yet.
 */
export function ClaudeProjectTrustCard({
  thread,
  environmentId,
  claude,
  draft,
}: {
  thread: Pick<EnvironmentThreadShell, "id" | "projectId" | "runtimeMode" | "interactionMode">;
  environmentId: EnvironmentId;
  /** The thread runs Claude. */
  claude: boolean;
  draft: boolean;
}) {
  const gt = useGT();
  const input = { projectId: thread.projectId, ...(draft ? {} : { threadId: thread.id }) };
  // In Full access everything runs without asking, so there is nothing to answer first.
  const asks =
    claude && !(thread.runtimeMode === "full-access" && thread.interactionMode === "default");
  const query = useEnvironmentQuery(
    asks ? filesystemEnvironment.claudeProjectTrust({ environmentId, input }) : null,
  );
  const canTrust = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const setTrust = useAtomCommand(filesystemEnvironment.setClaudeProjectTrust);
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = query.data;
  if (!asks || shown?.status !== "untrusted" || shown.commands.length === 0) return null;

  async function trust() {
    setSaving(true);
    setError(null);
    const result = await setTrust({
      environmentId,
      input: { projectId: thread.projectId, trusted: true },
    });
    setSaving(false);
    query.refresh();
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(errorDisplayMessage(cause, m) ?? gt("Could not trust the project."));
    }
  }

  return (
    <View className="mx-3 mb-2 gap-1 rounded-xl border border-warning-foreground/25 bg-screen p-3">
      <Text className="text-sm font-t3-medium text-foreground">
        <T>Trust this project's Claude Code settings?</T>
      </Text>
      <Text className="text-sm text-foreground-muted">
        {reviewing
          ? gt(
              "A trusted project runs everything its Claude Code settings name, in every Claude thread of the project: hooks, helper commands, MCP servers and environment variables. They run on this environment's machine with your permissions, outside any agent sandbox. You are asked once per project, not again when the settings change. This is what they hold now. Trust applies from the next session on.",
            )
          : gt(
              "Until you do, Claude sessions here run without the project's hooks, helper commands, MCP servers and environment variables.",
            )}
      </Text>
      {reviewing ? (
        <ScrollView className="mt-1 max-h-56" nestedScrollEnabled>
          {shown.commands.map((hook, index) => (
            // Entries have no identity of their own and the list is replaced as a whole.
            // oxlint-disable-next-line react/no-array-index-key
            <View key={index} className="mb-2 gap-1">
              <Text className="text-xs text-foreground-muted">
                {hook.matcher === undefined ? hook.event : `${hook.event} · ${hook.matcher}`}
                {" · "}
                {SOURCE_FILES[hook.source]}
              </Text>
              <Text
                selectable
                className="rounded-lg bg-subtle p-2 font-mono text-xs text-foreground"
              >
                {hook.detail}
              </Text>
            </View>
          ))}
        </ScrollView>
      ) : null}
      {reviewing && !canTrust ? (
        <Text className="text-sm text-foreground-muted">
          <T>This connection cannot trust a project. Use a client that can use the terminal.</T>
        </Text>
      ) : null}
      {/* The margins cancel the 44pt touch height so the links sit 8pt under the text. */}
      <View className="-mb-3 -mt-2 flex-row flex-wrap gap-x-4">
        <CardAction
          label={reviewing ? gt("Hide what runs") : gt("Show what runs")}
          disabled={false}
          onPress={() => setReviewing((current) => !current)}
        />
        {reviewing ? (
          <CardAction
            label={gt("Trust project")}
            disabled={!canTrust || saving || query.isPending}
            onPress={() => void trust()}
          />
        ) : null}
      </View>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function CardAction(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={{ left: 8, right: 8 }}
      onPress={props.onPress}
      className="min-h-11 justify-center active:opacity-70"
    >
      <Text
        className={
          props.disabled
            ? "text-sm font-t3-medium text-foreground-muted"
            : "text-sm font-t3-medium text-primary"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
