import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ChatAttachment,
  type ScopedThreadRef,
  type ThreadGuestMessage,
  type ThreadGuestShare,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { GUEST_PENDING_BUBBLE_CLASS_NAME, GuestMessageName } from "./guestMessageStyle";

const NO_GUEST_SHARE_ATOM = Atom.make<ThreadGuestShare | null>(null);

function guestShareAtom(ref: ScopedThreadRef) {
  let previous: ThreadGuestShare | null = null;
  return Atom.make((get) => {
    const next =
      get(environmentThreadDetails.threadAtom(ref))?.projection.thread.guestShare ?? null;
    // The thread record is replaced on unrelated updates; only share changes matter here.
    if (JSON.stringify(next) !== JSON.stringify(previous)) previous = next;
    return previous;
  });
}

export function useThreadGuestShare(threadRef: ScopedThreadRef | null): ThreadGuestShare | null {
  const shareAtom = useMemo(
    () => (threadRef === null ? NO_GUEST_SHARE_ATOM : guestShareAtom(threadRef)),
    [threadRef],
  );
  return useAtomValue(shareAtom);
}

function alertOnFailure(failureTitle: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(failureTitle, error instanceof Error ? error.message : "Try again.");
  }
}

/**
 * Owner controls for a guest link, above the composer: who the link is for and a way to stop
 * sharing. Links are created on web. Waiting messages show in the feed, see
 * `ThreadGuestPendingMessage`.
 */
export function ThreadGuestShareBar(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly canOperateThread: boolean;
}) {
  const { threadRef } = props;
  const share = useThreadGuestShare(threadRef);
  const closeGuestShare = useAtomCommand(threadEnvironment.closeGuestShare, "stop guest sharing");
  const [busy, setBusy] = useState(false);
  // The server keeps an expired link so waiting messages stay resolvable; the label flips when
  // it expires.
  // Keyed by the expiry, so a replaced link (even one already expired) gets its own timer.
  const [expiredAt, setExpiredAt] = useState<string | null>(null);
  const expiresAt = share?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = setTimeout(
      () => setExpiredAt(expiresAt),
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);
  if (threadRef === null || !share) return null;

  const disabled = busy || !props.canOperateThread;
  const stopSharing = () =>
    Dialog.confirm({
      title: "Stop sharing?",
      message: "The guest loses access and the link stops working.",
      confirmText: "Stop sharing",
      destructive: true,
      onConfirm: () => {
        if (disabled) return;
        setBusy(true);
        void closeGuestShare({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }).then((result) => {
          setBusy(false);
          alertOnFailure("Could not stop sharing", result);
        });
      },
    });

  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <SymbolView name="person.2" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        {expiredAt === share.expiresAt
          ? "Guest link expired"
          : share.guestName === null
            ? "Guest link active"
            : `${share.guestName} is a guest`}
      </Text>
      <Button label="Stop sharing" tone="text" disabled={disabled} onPress={stopSharing} />
    </View>
  );
}

/**
 * One guest message waiting at the end of the feed until the owner sends or dismisses it. Sent
 * ones then show in the feed as user messages with the guest's name.
 */
export function ThreadGuestPendingMessage(props: {
  readonly threadRef: ScopedThreadRef;
  readonly guestName: string;
  readonly message: ThreadGuestMessage;
  readonly bubbleMaxWidth: number | `${number}%`;
  /** The feed's own attachment rendering, so the owner sees the files before Send. */
  readonly renderAttachments: (attachments: ReadonlyArray<ChatAttachment>) => ReactNode;
}) {
  const { threadRef, guestName, message } = props;
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const resolveGuestMessage = useAtomCommand(
    threadEnvironment.resolveGuestMessage,
    "resolve guest message",
  );
  // One request at a time: a second tap while the first is in flight would double-send.
  const [busy, setBusy] = useState(false);

  const resolve = async (decision: "send" | "dismiss") => {
    if (busy) return;
    setBusy(true);
    const result = await resolveGuestMessage({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        guestMessageId: message.id,
        decision,
        creationSource: "mobile",
      },
    });
    setBusy(false);
    alertOnFailure(
      decision === "send" ? "Could not send guest message" : "Could not dismiss guest message",
      result,
    );
  };

  return (
    <View className="items-end pb-5">
      <GuestMessageName name={guestName} />
      <View className={GUEST_PENDING_BUBBLE_CLASS_NAME} style={{ maxWidth: props.bubbleMaxWidth }}>
        {message.text ? (
          <Text selectable className="text-base text-foreground">
            {message.text}
          </Text>
        ) : null}
        {props.renderAttachments(message.attachments ?? [])}
      </View>
      {canOperate ? (
        <View className="mt-1.5 flex-row gap-2">
          <Button
            label="Dismiss"
            tone="secondary"
            accessibilityLabel={`Dismiss message from ${guestName}`}
            disabled={busy}
            onPress={() => void resolve("dismiss")}
          />
          <Button
            label="Send"
            tone="primary"
            accessibilityLabel={`Send message from ${guestName}`}
            disabled={busy}
            onPress={() => void resolve("send")}
          />
        </View>
      ) : null}
    </View>
  );
}
