import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ThreadId,
  hostPressureCulprit,
  hostPressureRanking,
} from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { Pressable } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { environmentPresentations } from "../../state/presentation";
import { environmentServerConfigsAtom } from "../../state/server";
import { hostPressureAgentUsage } from "../home/hostPressureAgentUsage";

export interface ThreadHostPressureNote {
  readonly title: string;
  readonly detail: string;
}

/** Set while the thread's agent is among the heaviest on a connected machine short on memory or CPU. */
export function useThreadHostPressureNote(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ThreadHostPressureNote | null {
  const gt = useGT();
  // Selects the server's own agent object and primitives, so only culprit rows re-render.
  const agent = useAtomValue(environmentServerConfigsAtom, (configs) =>
    hostPressureCulprit(configs.get(environmentId)?.hostPressure, threadId),
  );
  const rankedBy = useAtomValue(environmentServerConfigsAtom, (configs) => {
    const pressure = configs.get(environmentId)?.hostPressure;
    return pressure === undefined ? "memory" : hostPressureRanking(pressure);
  });
  const connected = useAtomValue(
    environmentPresentations.presentationsAtom,
    (presentations) => presentations.get(environmentId)?.connection.phase === "connected",
  );
  if (agent === null || !connected) return null;
  const usage = hostPressureAgentUsage(gt, agent, rankedBy);
  return rankedBy === "memory"
    ? {
        title: gt("Memory is slowing agents down"),
        detail: gt(
          "Using {usage} while memory is slowing agents down. Stopping it helps the rest.",
          { usage },
        ),
      }
    : {
        title: gt("Machine overloaded"),
        detail: gt("Using {usage} while this machine is overloaded. Stopping it helps the rest.", {
          usage,
        }),
      };
}

export function showThreadHostPressureNote(note: ThreadHostPressureNote) {
  Dialog.alert(note.title, note.detail);
}

/** Marks a thread whose agent is among the heaviest on a machine short on memory or CPU. */
export function ThreadHostPressureIcon(props: {
  readonly note: ThreadHostPressureNote;
  readonly tintColorClassName: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.note.detail}
      hitSlop={8}
      onPress={() => showThreadHostPressureNote(props.note)}
      onLongPress={() => undefined}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <SymbolView
        name="exclamationmark.triangle"
        size={11}
        tintColorClassName={props.tintColorClassName}
        type="monochrome"
      />
    </Pressable>
  );
}
