import { msg, useMessages } from "gt-react-native";
import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  formatWorkingDurationLabel,
  resolveThreadWorkingStartedAt,
} from "@t3tools/client-runtime/state/models";
import {
  seatActivityLabel,
  type ThreadGroup,
  type ThreadGroupSeat,
} from "@t3tools/client-runtime/state/thread-group";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useQuietThreadShell } from "../../state/entities";
import {
  environmentThreads,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { useOpenLinkedThread } from "./useOpenLinkedThread";
import { useVisibleSecondClock } from "./use-visible-second-clock";

function SeatLiveRow(props: {
  readonly parentRef: ScopedThreadRef;
  readonly seat: ThreadGroupSeat;
}) {
  const m = useMessages();
  const { seat, parentRef } = props;
  const ref = scopeThreadRef(parentRef.environmentId, seat.threadId);
  useAtomMount(environmentThreads.stateAtom(ref.environmentId, ref.threadId));
  const shell = useQuietThreadShell(ref);
  const structure = useQuietThreadStructure(ref);
  const canStop = useEnvironmentScope(ref.environmentId, AuthOrchestrationOperateScope);
  const stop = useAtomCommand(threadEnvironment.interruptTurn);
  const openWork = useOpenLinkedThread();
  const startedAt = shell === null ? null : resolveThreadWorkingStartedAt(shell);
  const activity = seatActivityLabel(
    structure?.projection.turnItems ?? [],
    shell?.runtime?.activeRunId,
    m,
  );
  const now = useVisibleSecondClock(true);
  return (
    <View className="mx-3 mb-2 flex-row items-center gap-2 rounded-2xl bg-card px-3 py-1.5">
      <View className="min-w-0 flex-1">
        <Text className="text-xs text-foreground" numberOfLines={1}>
          {seat.label} · {activity}
        </Text>
        {startedAt === null ? null : (
          <Text className="text-xs tabular-nums text-foreground-muted">
            {formatWorkingDurationLabel(now - Date.parse(startedAt))}
          </Text>
        )}
      </View>
      <Button
        label={m(msg("Work"))}
        accessibilityLabel={m(msg("Open {name}’s work"), { name: seat.label })}
        tone="text"
        size="compact"
        onPress={() => openWork(ref)}
      />
      <Button
        label={m(msg("Stop"))}
        accessibilityLabel={m(msg("Stop {name}"), { name: seat.label })}
        tone="text"
        size="compact"
        disabled={!canStop}
        onPress={() =>
          void stop({ environmentId: ref.environmentId, input: { threadId: ref.threadId } })
        }
      />
    </View>
  );
}

export function ThreadGroupLiveRows(props: {
  readonly threadRef: ScopedThreadRef;
  readonly group: ThreadGroup;
}) {
  const running = useAtomValue(environmentThreadShells.runningGroupSeatsAtom(props.threadRef));
  return (
    <>
      {props.group.seats
        .filter((seat) => running.includes(seat.threadId))
        .map((seat) => (
          <SeatLiveRow key={seat.threadId} parentRef={props.threadRef} seat={seat} />
        ))}
    </>
  );
}
