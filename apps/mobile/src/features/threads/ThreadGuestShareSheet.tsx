import { useAtomValue } from "@effect/atom-react";
import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadGuestShare, ThreadId } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react-native";
import * as DateTime from "effect/DateTime";
import { useMemo, useState } from "react";
import { Platform, ScrollView, Share, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useDeadlinePassed } from "../../lib/clock";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { serverEnvironment } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadGuestShare } from "./ThreadGuestShareBar";

const TITLE = msg("Share with guest");
const COPY_FEEDBACK_DURATION_MS = 1200;
const PENDING_MESSAGES_NOTICE = msg(
  "Send or dismiss pending guest messages in the thread before creating a new link.",
);

type CreateState =
  | { readonly status: "idle" }
  | { readonly status: "creating" }
  | { readonly status: "created"; readonly url: string; readonly share: ThreadGuestShare }
  | { readonly status: "failed"; readonly message: string };

type GuestShareTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function ThreadGuestShareSheet({ route }: StaticScreenProps<GuestShareTarget>) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environmentId, threadId } = route.params;
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const guestShare = useThreadGuestShare(threadRef);
  const shareExpired = useDeadlinePassed(
    guestShare === null ? null : Date.parse(guestShare.expiresAt),
  );
  const activeShare = shareExpired ? null : guestShare;
  const hasPendingMessages =
    guestShare?.messages.some((message) => message.status === "pending") ?? false;
  // From the thread list the detail loads only now; until it does, an active link is unknown and a
  // new link would end it without the warning.
  const thread = useAtomValue(environmentThreadDetails.threadAtom(threadRef));
  const threadLoaded = thread !== null;
  const threadDeleted = useAtomValue(
    environmentThreadDetails.statusAtom(threadRef),
    (status) => status === "deleted",
  );
  const threadLoadError = useAtomValue(environmentThreadDetails.errorAtom(threadRef));
  const canCreate = useAtomValue(serverEnvironment.createGuestShare.permissionAtom(environmentId));
  const createGuestShare = useAtomCommand(serverEnvironment.createGuestShare, {
    reportFailure: false,
  });
  const [state, setState] = useState<CreateState>({ status: "idle" });
  const [copiedAtMs, setCopiedAtMs] = useState<number | null>(null);
  const copyFeedbackEnded = useDeadlinePassed(
    copiedAtMs === null ? null : copiedAtMs + COPY_FEEDBACK_DURATION_MS,
  );
  const copied = copiedAtMs !== null && !copyFeedbackEnded;
  const creating = state.status === "creating";
  const close = () => navigation.goBack();
  // The link is shown only once, so any dismiss mid-request (swipe, header, Android back) would lose it.
  usePreventRemove(creating, () => {});

  const create = async () => {
    if (hasPendingMessages) {
      Dialog.alert(gt("Guest messages are waiting"), m(PENDING_MESSAGES_NOTICE));
      return;
    }
    setState({ status: "creating" });
    const result = await createGuestShare({ environmentId, input: { threadId } });
    if (result._tag === "Success") {
      setState({ status: "created", url: result.value.url, share: result.value.share });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setState({ status: "idle" });
      return;
    }
    const error = squashAtomCommandFailure(result);
    setState({
      status: "failed",
      message: error instanceof Error ? error.message : gt("Could not create a guest link."),
    });
  };

  const copy = async (url: string) => {
    if (!(await tryCopyTextWithHaptic(url, { target: "guest link" }))) {
      Dialog.alert(gt("Could not copy"), gt("Try again."));
      return;
    }
    setCopiedAtMs(Date.now());
  };

  const share = (url: string) => {
    // Android ignores `url`; iOS turns a `message` URL into plain text instead of a link preview.
    Share.share(Platform.OS === "ios" ? { url } : { message: url }).catch((cause: unknown) => {
      console.error("Failed to share guest link.", cause);
      Dialog.alert(gt("Could not share the link"), gt("Copy it instead."));
    });
  };

  const createdShareExpired = useDeadlinePassed(
    state.status === "created" ? Date.parse(state.share.expiresAt) : null,
  );
  const createdLink =
    state.status === "created" &&
    !createdShareExpired &&
    !threadDeleted &&
    (thread === null ||
      DateTime.toEpochMillis(thread.projection.thread.updatedAt) <
        Date.parse(state.share.createdAt) ||
      (activeShare?.id === state.share.id && activeShare.guestName === null))
      ? state
      : null;

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="gap-5 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {createdLink !== null ? (
        <>
          <View className="gap-2">
            <View className="rounded-2xl border border-input-border bg-input px-3.5 py-3">
              <Text selectable numberOfLines={3} className="text-sm text-foreground">
                {createdLink.url}
              </Text>
            </View>
            <Text className="px-1 text-xs text-foreground-muted">
              <T>Send it to one person. It works once and expires in 24 hours.</T>
            </Text>
          </View>
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Button
                label={copied ? gt("Copied") : gt("Copy")}
                icon={copied ? "checkmark" : "doc.on.doc"}
                fullWidth
                onPress={() => void copy(createdLink.url)}
              />
            </View>
            <View className="flex-1">
              <Button
                label={gt("Share")}
                icon="square.and.arrow.up"
                tone="primary"
                fullWidth
                onPress={() => share(createdLink.url)}
              />
            </View>
          </View>
        </>
      ) : (
        <>
          <View className="flex-row gap-3">
            <View className="size-10 items-center justify-center rounded-full border border-border bg-card">
              <SymbolView
                name="person.badge.plus"
                size={18}
                tintColorClassName="accent-foreground"
              />
            </View>
            <Text className="min-w-0 flex-1 text-sm leading-normal text-foreground-secondary">
              <T>
                The guest sees the thread as you do, including command output and the agent's
                reasoning. Each message they send waits for you.
              </T>
            </Text>
          </View>
          <View className="gap-1.5">
            {!threadLoaded ? (
              <Text className="text-sm text-foreground-muted">
                {threadDeleted
                  ? gt("This thread was deleted.")
                  : (threadLoadError ?? gt("Checking for an active link…"))}
              </Text>
            ) : activeShare !== null ? (
              <Text className="text-sm text-foreground">
                {activeShare.guestName !== null
                  ? gt("{name} is a guest. A new link ends their access.", {
                      name: activeShare.guestName,
                    })
                  : gt("A guest link is active. A new link ends the current one.")}
              </Text>
            ) : (
              <Text className="text-sm text-foreground">
                <T>The link works once and expires in 24 hours.</T>
              </Text>
            )}
            {hasPendingMessages ? (
              <Text className="text-sm text-foreground-muted">{m(PENDING_MESSAGES_NOTICE)}</Text>
            ) : null}
            {state.status === "failed" ? (
              <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                {state.message}
              </Text>
            ) : null}
          </View>
          <Button
            label={
              creating
                ? gt("Creating link…")
                : state.status === "failed"
                  ? gt("Try again")
                  : activeShare !== null
                    ? gt("Create new link")
                    : gt("Create link")
            }
            tone="primary"
            fullWidth
            loading={creating}
            disabled={!canCreate || !threadLoaded || hasPendingMessages}
            onPress={() => void create()}
          />
        </>
      )}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <SheetHeader
          presentation="native"
          title={m(TITLE)}
          onClose={close}
          dismissDisabled={creating}
        />
        {content}
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-header">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AppBar sheet title={m(TITLE)} hideBottomBorder onBack={close} />
      <ScreenContent>{content}</ScreenContent>
    </View>
  );
}
