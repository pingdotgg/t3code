import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { findSandboxForWorktree } from "@t3tools/client-runtime/state/vcs";
import type { EnvironmentId, SandboxStatus } from "@t3tools/contracts";
import { useState } from "react";
import { Alert, Platform, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { showConfirmDialog } from "../../../components/ConfirmDialogHost";
import { cn } from "../../../lib/cn";
import { useEnvironmentServerConfig } from "../../../state/entities";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { vcsEnvironment } from "../../../state/vcs";
import { SheetListRow } from "./gitSheetComponents";

const STATUS_LABEL: Record<SandboxStatus, string> = {
  starting: "Starting",
  running: "Running",
  stopped: "Stopped",
  error: "Error",
};

function confirmRemove(onConfirm: () => void) {
  const title = "Remove sandbox?";
  const message = "Later work in this worktree then runs on the host.";
  if (Platform.OS === "ios") {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: onConfirm },
    ]);
    return;
  }
  showConfirmDialog({ title, message, confirmText: "Remove", destructive: true, onConfirm });
}

/**
 * Status, forwarded ports, and stop/remove actions for a thread whose worktree
 * runs in a Docker sandbox. Renders nothing for other threads, and only
 * subscribes to the sandbox list when the server can run sandboxes.
 */
export function ThreadSandboxCard(props: {
  readonly environmentId: EnvironmentId;
  readonly worktreePath: string | null;
}) {
  const serverConfig = useEnvironmentServerConfig(props.environmentId);
  const sandboxes = useEnvironmentQuery(
    serverConfig?.sandboxes === true && props.worktreePath !== null
      ? vcsEnvironment.sandboxes({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const sandbox = findSandboxForWorktree(sandboxes.data?.sandboxes, props.worktreePath);
  const stopSandbox = useAtomCommand(vcsEnvironment.stopSandbox, { reportFailure: false });
  const removeSandbox = useAtomCommand(vcsEnvironment.removeSandbox, { reportFailure: false });
  const [busy, setBusy] = useState(false);

  if (!sandbox) return null;
  const canStop = sandbox.status === "running" || sandbox.status === "starting";
  const { worktreePath } = sandbox;
  const run = async (failureTitle: string, command: typeof stopSandbox) => {
    setBusy(true);
    try {
      const result = await command({ environmentId: props.environmentId, input: { worktreePath } });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      Alert.alert(failureTitle, cause instanceof Error ? cause.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="overflow-hidden bg-card android:rounded-[20px] ios:rounded-[18px] ios:border ios:border-border">
      <View className="gap-0.5 px-4 py-3">
        <Text className="text-foreground-muted text-2xs font-t3-bold tracking-[0.9px] uppercase">
          Sandbox
        </Text>
        <Text
          selectable
          className={cn(
            "text-sm font-medium",
            sandbox.status === "error" ? "text-danger-foreground" : "text-foreground",
          )}
          numberOfLines={1}
        >
          {STATUS_LABEL[sandbox.status]} · {sandbox.containerName}
        </Text>
        {sandbox.status === "error" && sandbox.error ? (
          <Text selectable className="text-xs text-danger-foreground">
            {sandbox.error}
          </Text>
        ) : null}
        {sandbox.ports.map((port) => (
          <Text
            key={`${port.containerPort}:${port.hostPort}`}
            selectable
            className="text-xs text-foreground-muted"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            :{port.containerPort} → 127.0.0.1:{port.hostPort}
          </Text>
        ))}
      </View>
      <View className="ios:px-3">
        {canStop ? (
          <>
            {Platform.OS !== "android" ? <View className="h-px bg-border" /> : null}
            <SheetListRow
              icon="stop.fill"
              title="Stop sandbox"
              subtitle="Starts again on the next command"
              disabled={busy}
              onPress={() => void run("Could not stop sandbox", stopSandbox)}
            />
          </>
        ) : null}
        {Platform.OS !== "android" ? (
          <View className={canStop ? "ml-12 h-px bg-border" : "h-px bg-border"} />
        ) : null}
        <SheetListRow
          icon="trash"
          title="Remove sandbox"
          subtitle="Later work runs on the host"
          disabled={busy}
          onPress={() => confirmRemove(() => void run("Could not remove sandbox", removeSandbox))}
        />
      </View>
    </View>
  );
}
