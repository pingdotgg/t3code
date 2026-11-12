import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  OPEN_OWNED_WORK_STATUSES,
  OWNED_WORK_CLOSURE_UX,
  type OwnedWorkItem,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { useThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

function alertOnFailure(failureTitle: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(failureTitle, error instanceof Error ? error.message : "Try again.");
  }
}

function statusLabel(status: OwnedWorkItem["status"]): string {
  switch (status) {
    case "assigned":
      return "Assigned";
    case "claimed":
      return "Claimed";
    case "in_progress":
      return "In progress";
    case "on_hold":
      return "On hold";
    case "needs_attention":
      return "Needs attention";
    case "handed_off":
      return "Handed off";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
  }
}

/**
 * Settlement-blocking owned work above the composer: status plus Done / Cancel / Resume.
 * Assign and full history live in Thread Details on web. Items come from the project board.
 */
export function ThreadOwnedWorkBar(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly canOperateThread: boolean;
}) {
  const { threadRef } = props;
  const shell = useThreadShell(threadRef);
  const [items, setItems] = useState<ReadonlyArray<OwnedWorkItem>>([]);
  const listOwnedWorkInbox = useAtomCommand(
    threadEnvironment.listOwnedWorkInbox,
    "list owned work inbox",
  );
  const complete = useAtomCommand(threadEnvironment.completeOwnedWork, "complete owned work");
  const cancel = useAtomCommand(threadEnvironment.cancelOwnedWork, "cancel owned work");
  const resume = useAtomCommand(threadEnvironment.resumeOwnedWork, "resume owned work");
  const [busyItemId, setBusyItemId] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- load this seat's project-scoped inbox
  useEffect(() => {
    if (threadRef === null || shell === null) return;
    let cancelled = false;
    void listOwnedWorkInbox({
      environmentId: threadRef.environmentId,
      input: { projectId: shell.projectId, actorThreadId: threadRef.threadId },
    }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) setItems([]);
        return;
      }
      setItems(
        result.value.entries
          .map((entry) => entry.item)
          .filter((item) => OPEN_OWNED_WORK_STATUSES.has(item.status)),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [threadRef, shell, listOwnedWorkInbox]);

  if (threadRef === null || shell === null || items.length === 0) return null;

  const disabled = busyItemId !== null || !props.canOperateThread;
  const projectId = shell.projectId;

  const run = (
    item: OwnedWorkItem,
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
    failureTitle: string,
  ) => {
    if (disabled) return;
    setBusyItemId(item.id);
    void action().then((result) => {
      setBusyItemId(null);
      alertOnFailure(failureTitle, result);
      if (result._tag === "Success") {
        void listOwnedWorkInbox({
          environmentId: threadRef.environmentId,
          input: { projectId, actorThreadId: threadRef.threadId },
        }).then((refresh) => {
          if (refresh._tag === "Success") {
            setItems(
              refresh.value.entries
                .map((entry) => entry.item)
                .filter((entry) => OPEN_OWNED_WORK_STATUSES.has(entry.status)),
            );
          }
        });
      }
    });
  };

  return (
    <View className="gap-2 px-4 pb-2">
      {items.map((item) => {
        const waiting = item.status === "on_hold" || item.status === "needs_attention";
        const reason = item.holdReason ?? item.attentionReason ?? item.progress;
        const canComplete = item.status !== "assigned" && item.status !== "handed_off";
        return (
          <View key={item.id} className="gap-1 rounded-lg bg-subtle px-3 py-2">
            <View className="flex-row items-center gap-2">
              <SymbolView
                name="list.number"
                size={12}
                tintColorClassName="accent-foreground-muted"
              />
              <Text
                className="min-w-0 flex-1 text-xs font-medium text-foreground"
                numberOfLines={1}
              >
                {item.title}
              </Text>
              <Text className="text-xs text-foreground-muted">{statusLabel(item.status)}</Text>
            </View>
            {reason ? (
              <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                {reason}
              </Text>
            ) : null}
            {props.canOperateThread ? (
              <View className="flex-row flex-wrap gap-2 pt-1">
                {waiting ? (
                  <Button
                    label="Resume"
                    tone="text"
                    disabled={disabled}
                    onPress={() =>
                      run(
                        item,
                        () =>
                          resume({
                            environmentId: threadRef.environmentId,
                            input: {
                              threadId: threadRef.threadId,
                              projectId,
                              itemId: item.id,
                              actorThreadId: threadRef.threadId,
                            },
                          }),
                        "Could not resume work",
                      )
                    }
                  />
                ) : null}
                {canComplete ? (
                  <Button
                    label={OWNED_WORK_CLOSURE_UX.done.label}
                    tone="text"
                    disabled={disabled}
                    onPress={() =>
                      run(
                        item,
                        () =>
                          complete({
                            environmentId: threadRef.environmentId,
                            input: {
                              threadId: threadRef.threadId,
                              projectId,
                              itemId: item.id,
                              closureReason: OWNED_WORK_CLOSURE_UX.done.reason,
                              actorThreadId: threadRef.threadId,
                            },
                          }),
                        "Could not complete work",
                      )
                    }
                  />
                ) : null}
                <Button
                  label={OWNED_WORK_CLOSURE_UX.cancel.label}
                  tone="text"
                  disabled={disabled}
                  onPress={() =>
                    Dialog.confirm({
                      title: "Cancel this work?",
                      message: "Marks the item canceled. History stays on the project board.",
                      confirmText: OWNED_WORK_CLOSURE_UX.cancel.label,
                      destructive: true,
                      onConfirm: () =>
                        run(
                          item,
                          () =>
                            cancel({
                              environmentId: threadRef.environmentId,
                              input: {
                                threadId: threadRef.threadId,
                                projectId,
                                itemId: item.id,
                                actorThreadId: threadRef.threadId,
                              },
                            }),
                          "Could not cancel work",
                        ),
                    })
                  }
                />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
