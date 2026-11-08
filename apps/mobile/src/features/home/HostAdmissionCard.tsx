import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useQuietThreadShell, useServerConfigs } from "../../state/entities";
import { useOpenLinkedThread } from "../threads/useOpenLinkedThread";

const MAX_LISTED_THREADS = 5;

/** New turns wait here while the host is full or busy, so name them instead of leaving threads silent. */
export function HostAdmissionCard() {
  const configs = useServerConfigs();
  const waiting = [...configs].flatMap(([environmentId, config]) =>
    config.hostAdmission !== undefined && config.hostAdmission.waitingTurns > 0
      ? [{ environmentId, config, admission: config.hostAdmission }]
      : [],
  );
  if (waiting.length === 0) return null;
  return (
    <View className="gap-2 px-4 pb-2">
      {waiting.map(({ environmentId, config, admission }) => {
        const turns = `${admission.waitingTurns} ${admission.waitingTurns === 1 ? "turn" : "turns"} waiting`;
        const running =
          admission.maxRunningTurns === null
            ? `${admission.runningTurns} running`
            : `${admission.runningTurns}/${admission.maxRunningTurns} running`;
        const summary = `${turns} · ${running}`;
        const listed = admission.waitingThreadIds.slice(0, MAX_LISTED_THREADS);
        const hidden = admission.waitingThreadIds.length - listed.length;
        return (
          <View
            key={environmentId}
            accessibilityRole="summary"
            className="gap-2 rounded-2xl border border-border bg-card px-3.5 py-3"
          >
            <View className="flex-row items-center gap-2">
              <SymbolView name="clock" size={14} tintColorClassName="accent-foreground-muted" />
              <AppText
                textRole="footnote"
                className="min-w-0 flex-1 font-t3-medium text-foreground"
              >
                {configs.size > 1 ? `${config.environment.label}: ${summary}` : summary}
              </AppText>
            </View>
            {listed.map((threadId) => (
              <HostAdmissionThreadRow
                key={threadId}
                environmentId={environmentId}
                threadId={threadId}
              />
            ))}
            {hidden > 0 ? (
              <AppText textRole="caption" className="text-muted-foreground">
                {`and ${hidden} more`}
              </AppText>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function HostAdmissionThreadRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const thread = useQuietThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const openThread = useOpenLinkedThread();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => openThread({ environmentId: props.environmentId, threadId: props.threadId })}
      className="active:opacity-70"
    >
      <AppText textRole="footnote" numberOfLines={1} className="text-foreground">
        {thread?.title ?? "Thread"}
      </AppText>
    </Pressable>
  );
}
