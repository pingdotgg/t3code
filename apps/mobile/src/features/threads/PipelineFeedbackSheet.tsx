import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  buildCoordinatorFeedbackMessage,
  pipelineFeedbackRoutes,
  stepName,
} from "@t3tools/client-runtime/pipeline-run-presentation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  MessageId,
  PipelineRunId,
  PipelineStepId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { useState } from "react";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

export type PipelineFeedbackRouteParams = {
  readonly environmentId: string;
  readonly runId: string;
  /** Set to send straight to this step; omitted when the user can also pick the coordinator. */
  readonly stepIndex?: number;
  /** Set when the feedback is about a message in a step thread. */
  readonly quote?: string;
  readonly sourceThreadId?: string;
  readonly sourceStepId?: string;
};

type Route = "coordinator" | number;

function lengthValidationMessage(text: string): string | null {
  const excess = text.length - PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  if (excess <= 0) return null;
  return `Feedback is ${excess.toLocaleString("en-US")} ${excess === 1 ? "character" : "characters"} over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")}-character limit. Shorten it before sending.`;
}

export function PipelineFeedbackSheet({ route }: StaticScreenProps<PipelineFeedbackRouteParams>) {
  const params = route.params;
  const environmentId = EnvironmentId.make(params.environmentId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const runQuery = useEnvironmentQuery(
    serverEnvironment.pipelineRunLive({
      environmentId,
      input: { runId: PipelineRunId.make(params.runId) },
    }),
  );
  const run = runQuery.data?.run ?? null;
  const canRevise = useAtomValue(
    serverEnvironment.revisePipelineStep.permissionAtom(environmentId),
  );
  const revise = useAtomCommand(serverEnvironment.revisePipelineStep, {
    label: "pipeline revise step",
    reportFailure: false,
  });
  const fixedStep = params.stepIndex;
  const chooserVisible = fixedStep === undefined;
  const [selected, setSelected] = useState<Route>("coordinator");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const openThread = useOpenLinkedThread();

  const target: Route = fixedStep ?? selected;
  const options = run === null ? [] : pipelineFeedbackRoutes(run);
  const trimmed = note.trim();
  const coordinatorText = (() => {
    if (run === null || target !== "coordinator") return null;
    const sourceIndex = run.steps.findIndex((step) => step.stepId === params.sourceStepId);
    const sourceName = sourceIndex < 0 ? "this step" : stepName(run, sourceIndex);
    const sourceThreadId = params.sourceThreadId ?? run.steps[sourceIndex]?.childThreadId ?? null;
    return buildCoordinatorFeedbackMessage({
      quote: params.quote ?? "",
      sourceStepName: sourceName,
      sourceStepLink:
        sourceThreadId === null
          ? sourceName
          : formatThreadLink({ environmentId, threadId: ThreadId.make(sourceThreadId) }),
      note: trimmed,
    });
  })();
  const lengthMessage = lengthValidationMessage(coordinatorText ?? trimmed);
  const canSend =
    run !== null &&
    trimmed.length > 0 &&
    lengthMessage === null &&
    !sending &&
    (target === "coordinator" ? true : canRevise);

  const send = async () => {
    if (run === null || !canSend) return;
    setSending(true);
    try {
      if (coordinatorText !== null) {
        if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
          Dialog.alert("Could not send feedback", "You cannot message this pipeline.");
          return;
        }
        const metadata = makeQueuedMessageMetadata();
        await enqueueThreadOutboxMessage({
          environmentId,
          threadId: run.parentThreadId,
          messageId: MessageId.make(metadata.messageId),
          commandId: CommandId.make(metadata.commandId),
          text: coordinatorText,
          attachments: [],
          createdAt: metadata.createdAt,
        });
        navigation.dispatch(
          StackActions.replace("PipelineCoordinator", {
            environmentId: params.environmentId,
            threadId: String(run.parentThreadId),
          }),
        );
        return;
      }
      if (target === "coordinator") return;
      const result = await revise({
        environmentId,
        input: {
          runId: run.id,
          stepIndex: target,
          feedback: trimmed,
          ...(params.quote ? { quote: params.quote } : {}),
          ...(params.sourceStepId
            ? { sourceStepId: PipelineStepId.make(params.sourceStepId) }
            : {}),
        },
      });
      if (result._tag === "Success") {
        navigation.goBack();
        const revisedThreadId = run.steps[target]?.childThreadId ?? null;
        Dialog.alert(
          "Feedback sent",
          `${stepName(run, target)} is revising. Later steps redo their work after it.`,
          revisedThreadId === null
            ? undefined
            : [
                { text: "Done", style: "cancel" },
                {
                  text: "Open step",
                  onPress: () =>
                    openThread({
                      environmentId: params.environmentId,
                      threadId: String(revisedThreadId),
                    }),
                },
              ],
        );
      } else if (!isAtomCommandInterrupted(result)) {
        Dialog.alert("Could not send feedback", String(squashAtomCommandFailure(result)));
      }
    } catch (error) {
      Dialog.alert(
        "Could not send feedback",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setSending(false);
    }
  };

  const targetName =
    typeof target === "number" && run !== null ? `${target + 1}. ${stepName(run, target)}` : null;

  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1"
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions
          options={{ sheetCornerRadius: 28, sheetAllowedDetents: "fitToContents" }}
        />
      ) : null}
      <SheetHeader
        presentation={Platform.OS === "android" ? "inline" : "native"}
        title="Send feedback"
        onCancel={() => navigation.goBack()}
        accessibilityLabel="Cancel feedback"
        confirm={{
          label: "Send",
          onPress: () => void send(),
          disabled: !canSend,
          loading: sending,
        }}
      />
      <ScreenContent fitToContents>
        <ScrollView
          nestedScrollEnabled
          contentInsetAdjustmentBehavior="automatic"
          className="android:shrink android:grow-0 ios:flex-1"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          contentContainerClassName="px-5 pt-4 pb-6 gap-5"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {params.quote ? (
            <View className="gap-1 border-l-2 border-border pl-3">
              <Text className="text-xs font-t3-medium text-foreground-muted">Quoted</Text>
              <Text className="text-sm text-foreground-secondary" numberOfLines={8}>
                {params.quote}
              </Text>
            </View>
          ) : null}
          {run === null ? (
            <Text className="text-sm text-foreground-muted">
              {runQuery.error ?? "Loading pipeline…"}
            </Text>
          ) : null}
          {targetName !== null && !chooserVisible ? (
            <Text className="text-sm text-foreground-secondary">To step {targetName}</Text>
          ) : null}
          <View className="gap-2">
            <Text className="text-sm font-t3-medium text-foreground">Your feedback</Text>
            <TextInput
              multiline
              autoFocus
              accessibilityLabel="Feedback"
              value={note}
              onChangeText={setNote}
              placeholder="What should change?"
              textAlignVertical="top"
              className="min-h-24 rounded-xl bg-subtle px-4 py-3 text-base"
            />
            {lengthMessage === null ? null : (
              <Text className="text-xs text-danger-text">{lengthMessage}</Text>
            )}
          </View>
          {chooserVisible ? (
            <View className="gap-1">
              <Text className="pb-1 text-sm font-t3-medium text-foreground">Send to</Text>
              <RouteRow
                label="Coordinator decides"
                hint="The coordinator picks which step to revise."
                selected={target === "coordinator"}
                onPress={() => setSelected("coordinator")}
              />
              {options.map((option) => (
                <RouteRow
                  key={option.stepIndex}
                  label={`${option.stepIndex + 1}. ${option.name}`}
                  hint={option.hint}
                  disabled={option.disabled || !canRevise}
                  selected={target === option.stepIndex}
                  onPress={() => setSelected(option.stepIndex)}
                />
              ))}
            </View>
          ) : null}
          {target !== "coordinator" ? (
            <Text className="text-xs text-foreground-muted">
              Later steps redo their work after this feedback. A later step that is running is
              stopped.
            </Text>
          ) : null}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}

function RouteRow(props: {
  readonly label: string;
  readonly hint: string | null;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={props.label}
      accessibilityHint={props.hint ?? undefined}
      accessibilityState={{ selected: props.selected, disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-12 flex-row items-center gap-3 border-t border-border-subtle py-2",
        props.disabled && "opacity-50",
      )}
    >
      <View
        className={cn(
          "size-5 items-center justify-center rounded-full",
          props.selected ? "bg-primary" : "border border-input-border",
        )}
      >
        {props.selected ? (
          <SymbolView name="checkmark" size={13} tintColorClassName="accent-primary-foreground" />
        ) : null}
      </View>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-sm font-t3-medium text-foreground">
          {props.label}
        </Text>
        {props.hint ? <Text className="text-xs text-foreground-muted">{props.hint}</Text> : null}
      </View>
    </Pressable>
  );
}
