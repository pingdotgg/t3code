import { useNavigation } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { cn } from "../../lib/cn";
import { useEnvironments } from "../../state/environments";
import { threadHandoffEnvironment, useCanMoveThreads } from "../../state/threadHandoff";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOpenLinkedThread, useOpenLinkedThreadRead } from "./useOpenLinkedThread";

/**
 * A thread's move to a linked machine: waiting for its turn to end (with a way to keep it here),
 * under way, moved (with a way to open it there), or failed (with a way to try again).
 */
export function ThreadHandoffCard({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const gt = useGT();
  const navigation = useNavigation();
  const openThread = useOpenLinkedThread();
  const openLinkedRead = useOpenLinkedThreadRead();
  const cancel = useAtomCommand(threadHandoffEnvironment.cancel, { reportFailure: false });
  const canMove = useCanMoveThreads(thread.environmentId);
  const { presentationById } = useEnvironments();
  const [cancelling, setCancelling] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const handoff = thread.handoff;
  if (handoff === null || (handoff.state === "failed" && dismissed === handoff.handoffId)) {
    return null;
  }
  const machine = handoff.label;

  const keepHere = async () => {
    setCancelling(true);
    const result = await cancel({
      environmentId: thread.environmentId,
      input: { threadId: thread.id },
    });
    setCancelling(false);
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    Dialog.alert(
      gt("Could not cancel the move"),
      failure instanceof Error ? failure.message : gt("Try again."),
    );
  };

  const openThere = () => {
    if (handoff.state !== "departed") return;
    if (presentationById.get(handoff.environmentId)?.connection.phase === "connected") {
      openThread({ environmentId: handoff.environmentId, threadId: handoff.threadId });
      return;
    }
    // Without a connection to that machine, this one reads the thread over its link.
    openLinkedRead(
      { environmentId: handoff.environmentId, threadId: handoff.threadId },
      { viaEnvironmentId: thread.environmentId, label: machine },
      thread.title,
    );
  };

  const title =
    handoff.state === "pending"
      ? gt("Moving to {machine} when this turn ends", { machine })
      : handoff.state === "departing"
        ? gt("Moving to {machine}…", { machine })
        : handoff.state === "departed"
          ? gt("This thread continues on {machine}", { machine })
          : gt("Could not move to {machine}", { machine });
  const detail =
    handoff.state === "pending"
      ? gt("Sending a message keeps it here instead.")
      : handoff.state === "departed"
        ? gt("This copy is read-only.")
        : handoff.state === "failed"
          ? handoff.lastError
          : null;

  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-border-subtle bg-screen p-3">
      <Text
        className={cn(
          "text-sm font-t3-bold",
          handoff.state === "failed" ? "text-danger-foreground" : "text-foreground",
        )}
      >
        {title}
      </Text>
      {detail === null ? null : <Text className="text-sm text-foreground-secondary">{detail}</Text>}
      {handoff.state === "pending" ? (
        <Button
          label={gt("Keep it here")}
          size="compact"
          loading={cancelling}
          disabled={!canMove}
          onPress={() => void keepHere()}
        />
      ) : handoff.state === "departed" ? (
        <Button
          label={gt("Open on {machine}", { machine })}
          size="compact"
          icon="arrow.up.right"
          onPress={openThere}
        />
      ) : handoff.state === "failed" ? (
        <View className="flex-row gap-2">
          {canMove ? (
            <Button
              label={gt("Try again")}
              size="compact"
              onPress={() =>
                navigation.navigate("ThreadHandoff", {
                  environmentId: thread.environmentId,
                  threadId: thread.id,
                })
              }
            />
          ) : null}
          <Button
            label={gt("Dismiss")}
            size="compact"
            tone="text"
            onPress={() => setDismissed(handoff.handoffId)}
          />
        </View>
      ) : null}
    </View>
  );
}
