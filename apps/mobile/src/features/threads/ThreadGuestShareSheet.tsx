import { useAtomValue } from "@effect/atom-react";
import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Platform, ScrollView, Share, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useDeadlinePassed } from "../../lib/clock";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadGuestShare } from "./ThreadGuestShareBar";

const TITLE = "Share with guest";
const COPY_FEEDBACK_DURATION_MS = 1200;

/**
 * Whether this environment offers "Share with guest": the user may create links there, and its
 * Guest links beta is on (Settings > Labs). The server refuses links while the beta is off.
 */
export function useCanShareWithGuest(environmentId: EnvironmentId | null): boolean {
  const permitted = useAtomValue(serverEnvironment.createGuestShare.permissionAtom(environmentId));
  const enabled = useAtomValue(
    environmentServerConfigsAtom,
    (configs) =>
      environmentId !== null && configs.get(environmentId)?.settings.guestSharingEnabled === true,
  );
  return permitted && enabled;
}

type CreateState =
  | { readonly status: "idle" }
  | { readonly status: "creating" }
  | { readonly status: "created"; readonly url: string }
  | { readonly status: "failed"; readonly message: string };

type GuestShareTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function ThreadGuestShareSheet({ route }: StaticScreenProps<GuestShareTarget>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environmentId, threadId } = route.params;
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const activeShare = useThreadGuestShare(threadRef);
  // From the thread list the detail loads only now; until it does, an active link is unknown and a
  // new link would end it without the warning.
  const threadLoaded = useAtomValue(
    environmentThreadDetails.threadAtom(threadRef),
    (thread) => thread !== null,
  );
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
    setState({ status: "creating" });
    const result = await createGuestShare({ environmentId, input: { threadId } });
    if (result._tag === "Success") {
      setState({ status: "created", url: result.value.url });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setState({ status: "idle" });
      return;
    }
    const error = squashAtomCommandFailure(result);
    setState({
      status: "failed",
      message: error instanceof Error ? error.message : "Could not create a guest link.",
    });
  };

  const copy = async (url: string) => {
    if (!(await tryCopyTextWithHaptic(url, { target: "guest link" }))) {
      Dialog.alert("Could not copy", "Try again.");
      return;
    }
    setCopiedAtMs(Date.now());
  };

  const share = (url: string) => {
    // Android ignores `url`; iOS turns a `message` URL into plain text instead of a link preview.
    Share.share(Platform.OS === "ios" ? { url } : { message: url }).catch((cause: unknown) => {
      console.error("Failed to share guest link.", cause);
      Dialog.alert("Could not share the link", "Copy it instead.");
    });
  };

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="gap-5 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {state.status === "created" ? (
        <>
          <View className="gap-2">
            <View className="rounded-2xl border border-input-border bg-input px-3.5 py-3">
              <Text selectable numberOfLines={3} className="text-sm text-foreground">
                {state.url}
              </Text>
            </View>
            <Text className="px-1 text-xs text-foreground-muted">
              Send it to one person. It works once and expires in 24 hours.
            </Text>
          </View>
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Button
                label={copied ? "Copied" : "Copy"}
                icon={copied ? "checkmark" : "doc.on.doc"}
                fullWidth
                onPress={() => void copy(state.url)}
              />
            </View>
            <View className="flex-1">
              <Button
                label="Share"
                icon="square.and.arrow.up"
                tone="primary"
                fullWidth
                onPress={() => share(state.url)}
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
              The guest sees the thread as you do, including command output and the agent&apos;s
              reasoning. Each message they send waits for you.
            </Text>
          </View>
          <View className="gap-1.5">
            {!threadLoaded ? (
              <Text className="text-sm text-foreground-muted">
                {threadDeleted
                  ? "This thread was deleted."
                  : (threadLoadError ?? "Checking for an active link…")}
              </Text>
            ) : activeShare !== null ? (
              <Text className="text-sm text-foreground">
                {activeShare.guestName !== null
                  ? `${activeShare.guestName} is a guest. A new link ends their access.`
                  : "A guest link is active. A new link ends the current one."}
              </Text>
            ) : (
              <Text className="text-sm text-foreground">
                The link works once and expires in 24 hours.
              </Text>
            )}
            {state.status === "failed" ? (
              <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                {state.message}
              </Text>
            ) : null}
          </View>
          <Button
            label={
              creating
                ? "Creating link…"
                : state.status === "failed"
                  ? "Try again"
                  : activeShare !== null
                    ? "Create new link"
                    : "Create link"
            }
            tone="primary"
            fullWidth
            loading={creating}
            disabled={!canCreate || !threadLoaded}
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
          title={TITLE}
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
      <AndroidSheetHeader title={TITLE} hideBottomBorder onBack={close} />
      <ScreenContent>{content}</ScreenContent>
    </View>
  );
}
