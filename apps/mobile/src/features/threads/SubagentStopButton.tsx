import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OrchestrationV2Subagent } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { IconButton } from "../../components/ui/IconButton";
import { orchestrationEnvironment } from "../../state/orchestration";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  resolveSubagentRowPresentation,
  resolveSubagentStopTarget,
} from "./threadAgentsPresentation";

/** Whether a stop control shows for this subagent, so a feature can reserve its slot only then. */
export function useSubagentStopAvailable(
  environmentId: EnvironmentId,
  subagent: OrchestrationV2Subagent,
): boolean {
  const target = resolveSubagentStopTarget(subagent);
  const canStop = useAtomValue(orchestrationEnvironment.stopWorkflow.permissionAtom(environmentId));
  return target !== null && canStop;
}

export function SubagentStopButton(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: OrchestrationV2Subagent;
}) {
  const gt = useGT();
  const messages = useMessages();
  const target = resolveSubagentStopTarget(props.subagent);
  const available = useSubagentStopAvailable(props.environmentId, props.subagent);
  const stopWorkflow = useAtomCommand(orchestrationEnvironment.stopWorkflow);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);
  const [stopping, setStopping] = useState(false);

  if (target === null || !available) return null;

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

  return (
    <View>
      <IconButton
        icon="stop.fill"
        variant="danger"
        size="compact"
        accessibilityLabel={
          workflow
            ? stopping
              ? gt("Stopping workflow {label}", { label })
              : gt("Stop workflow {label}", { label })
            : stopping
              ? gt("Stopping agent {label}", { label })
              : gt("Stop agent {label}", { label })
        }
        disabled={stopping}
        onPress={() =>
          Dialog.confirm({
            title: workflow ? gt("Stop workflow?") : gt("Stop agent?"),
            message: workflow
              ? gt("Every running agent in {label} stops.", { label })
              : gt("Stop {label}?", { label }),
            confirmText: gt("Stop", { $context: "verb, confirm button" }),
            destructive: true,
            onConfirm: () => void stop(),
          })
        }
      />
    </View>
  );
}
