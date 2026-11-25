import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthTerminalOperateScope,
  type ClaudeProjectHook,
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

const SOURCE_FILES: Record<ClaudeProjectHook["source"], string> = {
  project: ".claude/settings.json",
  local: ".claude/settings.local.json",
};

/**
 * Shown in a Claude thread below Full access whose folder declares hooks nobody approved: says
 * they do not run, shows them in full, and approves them. `draft` reads the project's folder,
 * because the thread has none of its own yet.
 */
export function ClaudeProjectHooksCard({
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
  // In Full access the hooks run without asking, so there is nothing to approve first.
  const asks =
    claude && !(thread.runtimeMode === "full-access" && thread.interactionMode === "default");
  const query = useEnvironmentQuery(
    asks ? filesystemEnvironment.claudeProjectHooks({ environmentId, input }) : null,
  );
  const canApprove = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const approve = useAtomCommand(filesystemEnvironment.approveClaudeProjectHooks);
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = query.data;
  if (!asks || shown?.status !== "needs-approval") return null;

  async function approveShown(hooksHash: string) {
    setSaving(true);
    setError(null);
    const result = await approve({ environmentId, input: { ...input, hooksHash } });
    setSaving(false);
    query.refresh();
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(errorDisplayMessage(cause, m) ?? gt("Could not approve the hooks."));
    }
  }

  return (
    <View className="mx-3 mb-2 gap-1 rounded-xl border border-warning-foreground/25 bg-screen p-3">
      <Text className="text-sm font-t3-medium text-foreground">
        <T>This project's Claude hooks are waiting for your approval</T>
      </Text>
      <Text className="text-sm text-foreground-muted">
        {reviewing
          ? gt(
              "These commands come from the project's Claude Code settings. They run on this environment's machine with your permissions, outside any agent sandbox. Once approved they run in every Claude thread of this project, starting with the next session. You are asked again whenever they change.",
            )
          : gt("Claude sessions here run without them until you approve.")}
      </Text>
      {reviewing ? (
        <ScrollView className="mt-1 max-h-56" nestedScrollEnabled>
          {shown.hooks.map((hook, index) => (
            // Hooks have no identity of their own and the list is replaced as a whole.
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
      {reviewing && !canApprove ? (
        <Text className="text-sm text-foreground-muted">
          <T>This connection cannot approve hooks. Use a client that can use the terminal.</T>
        </Text>
      ) : null}
      {/* The margins cancel the 44pt touch height so the links sit 8pt under the text. */}
      <View className="-mb-3 -mt-2 flex-row flex-wrap gap-x-4">
        <CardAction
          label={reviewing ? gt("Hide hooks") : gt("Review hooks")}
          disabled={false}
          onPress={() => setReviewing((current) => !current)}
        />
        {reviewing ? (
          <CardAction
            label={gt("Approve hooks")}
            disabled={!canApprove || saving || query.isPending}
            onPress={() => void approveShown(shown.hooksHash)}
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
