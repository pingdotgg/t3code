import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, HostMemoryPressureAgent } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { useQuietThreadShell, useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOpenLinkedThread } from "../threads/useOpenLinkedThread";

const GiB = 1024 ** 3;

/** Agents throttled for memory stop answering, so name the heaviest ones while it lasts. */
export function MemoryPressureBanner() {
  const configs = useServerConfigs();
  const severe = [...configs].flatMap(([environmentId, config]) =>
    config.memoryPressure?.level === "severe"
      ? [{ environmentId, config, pressure: config.memoryPressure }]
      : [],
  );
  if (severe.length === 0) return null;
  return (
    <View className="gap-2 px-4 pb-2">
      {severe.map(({ environmentId, config, pressure }) => (
        <View
          key={environmentId}
          accessibilityRole="summary"
          className="gap-2 rounded-2xl border border-border bg-card px-3.5 py-3"
        >
          <View className="flex-row items-center gap-2">
            <SymbolView
              name="exclamationmark.triangle"
              size={14}
              tintColorClassName="accent-warning-foreground"
            />
            <AppText textRole="footnote" className="min-w-0 flex-1 font-t3-medium text-foreground">
              {configs.size > 1 ? `${config.environment.label} is low on memory` : "Low on memory"}
            </AppText>
          </View>
          <AppText textRole="caption" className="text-muted-foreground">
            Agents are being slowed down and may stop responding. Stopping the largest one helps the
            rest.
          </AppText>
          {pressure.heaviestAgents.map((agent, index) => (
            <MemoryPressureAgentRow
              key={agent.threadId ?? `${agent.agent}:${index}`}
              environmentId={environmentId}
              agent={agent}
              canForceStop={config.environment.capabilities.threadForceStop === true}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

function MemoryPressureAgentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: HostMemoryPressureAgent;
  readonly canForceStop: boolean;
}) {
  const threadId = props.agent.threadId;
  const thread = useQuietThreadShell(
    threadId === null ? null : scopeThreadRef(props.environmentId, threadId),
  );
  const openThread = useOpenLinkedThread();
  const permitted = useAtomValue(
    orchestrationEnvironment.forceStopThread.permissionAtom(props.environmentId),
  );
  const forceStopThread = useAtomCommand(orchestrationEnvironment.forceStopThread, {
    reportFailure: false,
  });
  const [stopping, setStopping] = useState(false);
  const name =
    thread?.title ?? (threadId === null ? `${props.agent.agent} (shared)` : props.agent.agent);
  const forceStop = async (target: NonNullable<typeof threadId>) => {
    setStopping(true);
    const result = await forceStopThread({
      environmentId: props.environmentId,
      input: { threadId: target },
    });
    setStopping(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert("Could not force stop the agent");
    }
  };
  return (
    <View className="flex-row items-center gap-3">
      <Pressable
        accessibilityRole={threadId === null ? undefined : "link"}
        disabled={threadId === null}
        onPress={() =>
          threadId === null
            ? undefined
            : openThread({ environmentId: props.environmentId, threadId })
        }
        className="min-w-0 flex-1 active:opacity-70"
      >
        <AppText textRole="footnote" numberOfLines={1} className="text-foreground">
          {name}
        </AppText>
      </Pressable>
      <AppText textRole="footnote" className="text-muted-foreground tabular-nums">
        {(props.agent.memoryBytes / GiB).toFixed(1)} GB
      </AppText>
      {threadId !== null && props.canForceStop && permitted ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Force stop ${name}`}
          disabled={stopping}
          hitSlop={8}
          onPress={() =>
            Dialog.confirm({
              title: "Force stop the agent?",
              message: `Force stop kills ${name}'s processes and ends its turn.`,
              confirmText: "Force stop",
              destructive: true,
              onConfirm: () => void forceStop(threadId),
            })
          }
          className={`active:opacity-70 ${stopping ? "opacity-50" : ""}`}
        >
          <AppText textRole="footnote" className="font-t3-medium text-danger-foreground">
            {stopping ? "Stopping..." : "Force stop"}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}
