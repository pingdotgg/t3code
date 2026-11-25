import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OrchestrationV2Subagent } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";

import * as Dialog from "../../components/ui/Dialog";
import { IconButton } from "../../components/ui/IconButton";
import { orchestrationEnvironment } from "../../state/orchestration";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  resolveSubagentRowPresentation,
  resolveSubagentStopTarget,
} from "./threadAgentsPresentation";

export function SubagentStopButton(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: OrchestrationV2Subagent;
  readonly className?: string;
  /** A small tinted control for dense lists, such as the thread's status card. */
  readonly compact?: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const target = resolveSubagentStopTarget(props.subagent);
  const canStop = useAtomValue(
    orchestrationEnvironment.stopWorkflow.permissionAtom(props.environmentId),
  );
  const stopWorkflow = useAtomCommand(orchestrationEnvironment.stopWorkflow);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);
  const [stopping, setStopping] = useState(false);

  if (target === null || !canStop) return null;

  const workflow = target.kind === "workflow";
  const label =
    props.subagent.workflow?.name ??
    resolveSubagentRowPresentation(props.subagent, false, messages).title;
  const stop = async () => {
    setStopping(true);
    const result = await (
      target.kind === "workflow"
        ? stopWorkflow({ environmentId: props.environmentId, input: target.input })
        : interruptTurn({ environmentId: props.environmentId, input: target.input })
    ).finally(() => setStopping(false));
    if (result._tag === "Failure") {
      Dialog.alert(workflow ? gt("Could not stop workflow") : gt("Could not stop agent"));
    }
  };

  const accessibilityLabel = workflow
    ? stopping
      ? gt("Stopping workflow {label}", { label })
      : gt("Stop workflow {label}", { label })
    : stopping
      ? gt("Stopping agent {label}", { label })
      : gt("Stop agent {label}", { label });
  const confirmStop = () =>
    Dialog.confirm({
      title: workflow ? gt("Stop workflow?") : gt("Stop agent?"),
      message: workflow
        ? gt("Every running agent in {label} stops.", { label })
        : gt("Stop {label}?", { label }),
      confirmText: gt("Stop", { $context: "verb, confirm button" }),
      destructive: true,
      onConfirm: () => void stop(),
    });

  if (props.compact) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled: stopping }}
        disabled={stopping}
        hitSlop={8}
        onPress={confirmStop}
        className={cn(
          "size-8 items-center justify-center rounded-full bg-danger active:opacity-70 disabled:opacity-40",
          props.className,
        )}
      >
        <SymbolView name="stop.fill" size={11} tintColorClassName="accent-danger-foreground" />
      </Pressable>
    );
  }

  return (
    <View className={props.className}>
      <IconButton
        icon="stop.fill"
        variant="danger"
        accessibilityLabel={accessibilityLabel}
        disabled={stopping}
        onPress={confirmStop}
      />
    </View>
  );
}
