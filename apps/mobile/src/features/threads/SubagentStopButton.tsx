import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OrchestrationV2Subagent } from "@t3tools/contracts";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
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
}) {
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
    props.subagent.workflow?.name ?? resolveSubagentRowPresentation(props.subagent).title;
  const confirmStop = () =>
    Alert.alert(
      workflow ? "Stop workflow?" : "Stop agent?",
      workflow ? `Every running agent in ${label} stops.` : `Stop ${label}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Stop",
          style: "destructive",
          onPress: async () => {
            setStopping(true);
            try {
              const result =
                target.kind === "workflow"
                  ? await stopWorkflow({ environmentId: props.environmentId, input: target.input })
                  : await interruptTurn({
                      environmentId: props.environmentId,
                      input: target.input,
                    });
              if (result._tag === "Failure") {
                Alert.alert(workflow ? "Could not stop workflow" : "Could not stop agent");
              }
            } finally {
              setStopping(false);
            }
          },
        },
      ],
    );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Stop ${workflow ? "workflow" : "agent"} ${label}`}
      accessibilityState={{ disabled: stopping, busy: stopping }}
      disabled={stopping}
      onPress={confirmStop}
      className={cn(
        "size-11 items-center justify-center active:opacity-70 disabled:opacity-50",
        props.className,
      )}
    >
      <View className="size-6 items-center justify-center rounded-full bg-danger">
        {stopping ? (
          <AppActivityIndicator size="small" />
        ) : (
          <SymbolView name="stop.fill" size={9} tintColorClassName="accent-danger-foreground" />
        )}
      </View>
    </Pressable>
  );
}
