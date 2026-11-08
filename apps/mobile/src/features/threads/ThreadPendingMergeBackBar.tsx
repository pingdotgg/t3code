import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolvePendingMergeBack } from "@t3tools/client-runtime/state/thread-workflows";
import {
  EnvironmentId,
  type OrchestrationV2ContextTransfer,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { useThreadShell } from "../../state/entities";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

const NO_PENDING_MERGE_BACK_ATOM = Atom.make<OrchestrationV2ContextTransfer | null>(null);
const decodeThreadKey = Schema.decodeUnknownSync(Schema.Tuple([EnvironmentId, ThreadId]));

// Keyed so the screen re-renders only when the pending transfer changes, not on every target update.
const pendingMergeBackAtom = Atom.family((key: string) => {
  const ref = scopeThreadRef(...decodeThreadKey(JSON.parse(key)));
  return Atom.make((get) =>
    resolvePendingMergeBack(get(environmentThreadDetails.quietThreadAtom(ref))?.projection),
  ).pipe(Atom.withLabel(`mobile-pending-merge-back:${key}`));
});

/** The merge-back the target thread will send with its next message. */
export function usePendingMergeBack(
  targetRef: ScopedThreadRef | null,
): OrchestrationV2ContextTransfer | null {
  return useAtomValue(
    targetRef === null
      ? NO_PENDING_MERGE_BACK_ATOM
      : pendingMergeBackAtom(JSON.stringify([targetRef.environmentId, targetRef.threadId])),
  );
}

/** Above the composer: the side chat or fork this thread's next message carries, and Cancel. */
export function ThreadPendingMergeBackBar(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly canOperateThread: boolean;
}) {
  const { threadRef } = props;
  const pending = usePendingMergeBack(threadRef);
  const source = useThreadShell(
    threadRef === null || pending === null
      ? null
      : scopeThreadRef(threadRef.environmentId, pending.sourceThreadId),
  );
  const cancelMergeBack = useAtomCommand(threadEnvironment.cancelMergeBack, {
    label: "cancel merge back",
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  if (threadRef === null || pending === null) return null;

  const cancel = async () => {
    setBusy(true);
    const result = await cancelMergeBack({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, transferId: pending.id },
    });
    setBusy(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    Dialog.alert(
      "Could not cancel the merge back",
      error instanceof Error ? error.message : "Try again.",
    );
  };

  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <SymbolView
        name={PullRequestGlyph.merged}
        size={12}
        tintColorClassName="accent-foreground-muted"
      />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        {source === null
          ? "Another thread goes with your next message"
          : `${source.lineage.sideChat ? "Side chat" : "Fork"} “${source.title}” goes with your next message`}
      </Text>
      {props.canOperateThread ? (
        <Button label="Cancel" tone="text" disabled={busy} onPress={() => void cancel()} />
      ) : null}
    </View>
  );
}
