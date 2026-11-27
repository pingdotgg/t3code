import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  useFocusEffect,
  useNavigation,
  usePreventRemove,
  type StaticScreenProps,
} from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { resolveLinkedThreadOpen } from "@t3tools/client-runtime/linked-thread";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSourceControlWriteScope,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { useCallback, useContext, useMemo, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProject, useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import {
  continueOnMachineInput,
  continueTargets,
  hasUnpushedWork,
  unpushedWork,
  type ContinueTargetBlock,
} from "./continueOnMachine";
import { useOpenLinkedThread, useOpenLinkedThreadRead } from "./useOpenLinkedThread";

const TITLE = msg("Continue on another machine");

type ContinueTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function ContinueOnMachineSheet({ route }: StaticScreenProps<ContinueTarget>) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const registry = useContext(RegistryContext);
  const { environmentId, threadId } = route.params;
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread === null ? null : { environmentId, projectId: thread.projectId },
  );
  const cwd = thread?.worktreePath ?? project?.workspaceRoot ?? null;
  const gitStatus = useEnvironmentQuery(
    cwd === null ? null : vcsEnvironment.status({ environmentId, input: { cwd } }),
  );
  const listAtom = peerLinkEnvironment.list({ environmentId, input: {} });
  const links = useEnvironmentQuery(listAtom);
  // Links change outside this client, and the shared list only revalidates when built.
  useFocusEffect(
    useCallback(() => {
      if (!registry.get(listAtom).waiting) registry.refresh(listAtom);
    }, [listAtom, registry]),
  );
  const { presentationById } = useEnvironments();
  const canContinue = useAtomValue(
    threadEnvironment.continueOnEnvironment.permissionAtom(environmentId),
  );
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const continueOnEnvironment = useAtomCommand(threadEnvironment.continueOnEnvironment, {
    reportFailure: false,
  });
  const openThread = useOpenLinkedThread();
  const openLinkedRead = useOpenLinkedThreadRead();

  const [pickedId, setPickedId] = useState<EnvironmentId | null>(null);
  const [commitAndPushPicked, setCommitAndPushPicked] = useState(false);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [openedAtMs] = useState(Date.now);
  usePreventRemove(submitting, () => {});

  const targets = continueTargets(links.data?.links ?? [], DateTime.makeUnsafe(openedAtMs));
  const available = targets.filter((target) => target.block === null);
  const picked =
    available.find((target) => target.environmentId === pickedId) ?? available[0] ?? null;
  const commitAndPush = commitAndPushPicked && canWriteSourceControl;
  const work = gitStatus.data === null ? null : unpushedWork(gitStatus.data);
  const needsPush = work !== null && hasUnpushedWork(work) && !commitAndPush;
  const running = thread !== null && threadRuntimeIsActive(thread.runtime);
  const close = () => navigation.goBack();

  const blockText = (block: ContinueTargetBlock, lastError: string | null) => {
    switch (block) {
      case "access":
        return gt("Needs a Full access link");
      case "expired":
        return gt("Expired. Link it again with a new pairing code.");
      case "unreachable":
        return lastError ?? gt("Not answering right now.");
    }
  };

  const confirmReason = running
    ? gt("The agent is working. Wait for the turn to end, or stop it.")
    : needsPush
      ? canWriteSourceControl
        ? gt("Turn on Commit and push my changes first, or push this branch yourself.")
        : gt("Commit and push this branch yourself first.")
      : null;

  const submit = async () => {
    if (picked === null || thread === null) return;
    setSubmitting(true);
    setFailure(null);
    const result = await continueOnEnvironment({
      environmentId,
      input: continueOnMachineInput({
        threadId,
        targetEnvironmentId: picked.environmentId,
        commitAndPush,
        message,
      }),
    });
    setSubmitting(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      setFailure(errorDisplayMessage(error, m) ?? gt("Could not continue the thread there."));
      return;
    }
    const moved = scopeThreadRef(result.value.targetEnvironmentId, result.value.targetThreadId);
    const own = presentationById.get(moved.environmentId);
    const opens = resolveLinkedThreadOpen({
      environmentId: moved.environmentId,
      viaEnvironmentId: environmentId,
      own: own && { connected: own.connection.phase === "connected" },
      linked: true,
    });
    if (opens === "linked") {
      openLinkedRead(
        moved,
        { viaEnvironmentId: environmentId, label: picked.label },
        result.value.title,
        { replace: true },
      );
      return;
    }
    navigation.goBack();
    openThread({ environmentId: String(moved.environmentId), threadId: String(moved.threadId) });
  };

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="gap-5 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      <Text className="text-sm leading-normal text-foreground-secondary">
        <T>
          The agent on the other machine gets the conversation and the branch. Only pushed commits
          move.
        </T>
      </Text>
      <ListSection title={gt("Machine", { $context: "linked machine to continue a thread on" })}>
        {links.error !== null ? (
          <Text className="p-4 text-sm text-danger-foreground">{links.error}</Text>
        ) : links.data === null ? (
          <Text className="p-4 text-sm text-foreground-muted">
            <T>Loading linked machines…</T>
          </Text>
        ) : targets.length === 0 ? (
          <Text className="p-4 text-sm text-foreground-muted">
            <T>No linked machines. Link this machine to another one with Full access first.</T>
          </Text>
        ) : (
          targets.map((target, index) => (
            <ListChoiceRow
              key={target.environmentId}
              label={target.label}
              description={
                target.block === null ? undefined : blockText(target.block, target.link.lastError)
              }
              selected={picked?.environmentId === target.environmentId}
              separated={index > 0}
              disabled={target.block !== null || submitting}
              onPress={() => setPickedId(target.environmentId)}
            />
          ))
        )}
      </ListSection>
      <View className="gap-2">
        {work !== null && hasUnpushedWork(work) ? (
          <View className="gap-0.5 px-1">
            {work.uncommittedChanges ? (
              <Text className="text-sm text-foreground">
                <T>This thread has uncommitted changes.</T>
              </Text>
            ) : null}
            {work.unpushedCommits > 0 ? (
              <Text className="text-sm text-foreground">
                {gt(
                  "{count, plural, =1 {One commit is not pushed.} other {{count} commits are not pushed.}}",
                  { count: work.unpushedCommits },
                )}
              </Text>
            ) : null}
            {work.branchNotPushed ? (
              <Text className="text-sm text-foreground">
                <T>This branch is not pushed yet.</T>
              </Text>
            ) : null}
          </View>
        ) : null}
        <ListSection>
          <ListToggleRow
            label={gt("Commit and push my changes first")}
            description={
              canWriteSourceControl
                ? undefined
                : gt("This connection cannot change source control.")
            }
            value={commitAndPush}
            disabled={submitting || !canWriteSourceControl}
            onValueChange={setCommitAndPushPicked}
          />
        </ListSection>
      </View>
      <View className="gap-2">
        <Text className="px-1 text-sm font-t3-medium text-foreground">
          <T>Message for the agent there</T>
        </Text>
        <TextInput
          multiline
          accessibilityLabel={gt("Message for the agent there")}
          value={message}
          onChangeText={setMessage}
          maxLength={PROVIDER_SEND_TURN_MAX_INPUT_CHARS}
          editable={!submitting}
          placeholder={gt("Optional")}
          textAlignVertical="top"
          className="min-h-20 rounded-xl bg-subtle px-4 py-3 text-base"
        />
        <Text className="px-1 text-xs text-foreground-muted">
          <T>
            With a message, the agent there starts at once. Without one, the thread waits for you.
          </T>
        </Text>
      </View>
      {confirmReason !== null ? (
        <Text className="text-sm text-foreground-muted">{confirmReason}</Text>
      ) : null}
      {failure !== null ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {failure}
        </Text>
      ) : null}
      <Button
        label={submitting ? gt("Continuing…") : gt("Continue there")}
        tone="primary"
        fullWidth
        loading={submitting}
        disabled={!canContinue || picked === null || thread === null || confirmReason !== null}
        onPress={() => void submit()}
      />
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <SheetHeader
          presentation="native"
          title={m(TITLE)}
          onClose={close}
          dismissDisabled={submitting}
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
