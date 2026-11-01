import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import type { SelectableMarkdownTextProps } from "../../native/SelectableMarkdownText.types";
import { useMarkdownImageSource } from "../../native/useMarkdownImageSource";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  flattenThemeColor,
  themeColorWithAlpha,
  themeColorWithContrast,
} from "../../lib/mobileTheme";
import { useThreadMarkdownLinkPress } from "./useThreadMarkdownLinkPress";
import { useThreadMarkdownImageRenderer } from "./useThreadMarkdownImageRenderer";
import { ThreadMediaVisibleContext } from "./ThreadMarkdownVideo";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { Button } from "../../components/ui/Button";
import { QuestionAttachments } from "./QuestionAttachments";
import type { EnvironmentId, ThreadId, RuntimeRequestId } from "@t3tools/contracts";
import type { ThreadUserInputQuestion } from "@t3tools/client-runtime/state/thread-requests";
import {
  markdownProseDirection,
  textDirection,
  type TextDirection,
} from "@t3tools/shared/textDirection";
import { useCallback, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  FadeInUp,
  FadeOutDown,
  useAnimatedStyle,
  useSharedValue,
  type DerivedValue,
  type SharedValue,
} from "react-native-reanimated";

import { USER_INPUT_TOGGLE_DURATION_MS } from "./pendingUserInputLayout";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { cn } from "../../lib/cn";
import { useLiveThreadLinkLabels } from "../../state/entities";
import { markdownAccessibility } from "../../lib/markdownDocument";
import { markdownFileEmbedLabel } from "../../lib/markdownMedia";
import {
  isPendingUserInputOptionSelected,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import type { PendingUserInput } from "../../lib/threadActivity";

export interface PendingUserInputCardProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
  readonly canOperateThread: boolean;
  readonly pendingUserInput: PendingUserInput;
  readonly maxHeight: DerivedValue<number>;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly onStopThread?: () => void;
  readonly cardProgress?: SharedValue<number>;
  readonly cardCoverage?: SharedValue<number>;
  readonly onInputFocusChange?: (focused: boolean) => void;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly answers: Record<string, string | ReadonlyArray<string>> | null;
  readonly respondingUserInputId: RuntimeRequestId | null;
  readonly onSelectOption: (
    requestId: RuntimeRequestId,
    question: ThreadUserInputQuestion,
    value: string,
  ) => void;
  readonly onChangeCustomAnswer: (
    requestId: RuntimeRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmit: () => Promise<unknown>;
  readonly onDismiss: () => Promise<unknown>;
}

/** Android cannot hit-test overlays beyond their parent's bounds; render its expanded card in-flow. */
const EXPANDED_CARD_IS_OVERLAY = Platform.OS === "ios";

function proseDirectionStyle(text: string, setDirection: TextDirection | undefined) {
  const direction = textDirection(text);
  return {
    ...(direction ? { direction, writingDirection: direction } : null),
    textAlign: (direction === "rtl") === (setDirection === "rtl") ? "left" : "right",
  } as const;
}

function QuestionText(
  props: SelectableMarkdownTextProps & {
    readonly environmentId: EnvironmentId;
    readonly setDirection: TextDirection | undefined;
  },
) {
  const { environmentId, setDirection, ...markdownProps } = props;
  const markdown = useLiveThreadLinkLabels(props.markdown, environmentId);
  return (
    <SelectableMarkdownText
      {...markdownProps}
      markdown={markdown}
      writingDirection={markdownProseDirection(markdown)}
      textAlign={Platform.OS === "android" ? undefined : setDirection === "rtl" ? "right" : "left"}
    />
  );
}

export function PendingUserInputCard(props: PendingUserInputCardProps) {
  const fileEmbedLabel = useCallback(
    (href: string, standalone: boolean) =>
      markdownFileEmbedLabel(
        href,
        {
          environmentId: props.environmentId,
          threadId: props.threadId,
          workspaceRoot: props.workspaceRoot,
        },
        standalone,
      ),
    [props.environmentId, props.threadId, props.workspaceRoot],
  );
  const questions = useMemo(
    () =>
      props.pendingUserInput.questions.map((question) => ({
        question,
        spokenFallback: markdownAccessibility(question.question, fileEmbedLabel).hasText
          ? undefined
          : question.question,
      })),
    [props.pendingUserInput.questions, fileEmbedLabel],
  );
  const styles = useMarkdownPreviewStyles();
  const theme = useUniwindTheme();
  const questionTextRole = useScaledTextRole("body");
  const optionTextRole = useScaledTextRole("footnote");
  const textStyles = useMemo(() => {
    const base = {
      ...styles.nativeTextStyle,
      linkColor: themeColorWithContrast(styles.nativeTextStyle.linkColor, [
        theme["--color-card-alt"],
        theme["--color-input"],
        flattenThemeColor(
          themeColorWithAlpha(theme["--color-primary"], 0.1),
          theme["--color-card-alt"],
        ),
      ]),
    };
    return {
      question: { ...base, ...questionTextRole, color: theme["--color-foreground"] },
      label: {
        ...base,
        color: theme["--color-foreground-secondary"],
        fontFamily: base.boldFontFamily,
        ...optionTextRole,
      },
      selectedLabel: {
        ...base,
        color: theme["--color-foreground"],
        fontFamily: base.boldFontFamily,
        ...optionTextRole,
      },
      description: {
        ...base,
        color: theme["--color-foreground-muted"],
        ...optionTextRole,
      },
    };
  }, [styles.nativeTextStyle, theme, questionTextRole, optionTextRole]);
  const [expandedFile, setExpandedFile] = useState<FilePreviewSource | null>(null);
  const [expandedVideo, setExpandedVideo] = useState<VideoPreviewSource | null>(null);
  const onLinkPress = useThreadMarkdownLinkPress({
    environmentId: props.environmentId,
    threadId: props.threadId,
    workspaceRoot: props.workspaceRoot,
    setExpandedFile,
    setExpandedVideo,
  });
  const resolveImageSource = useMarkdownImageSource({
    environmentId: props.environmentId,
    threadId: props.threadId,
    workspaceRoot: props.workspaceRoot,
  });
  const onImagePress = useCallback((href: string) => onLinkPress(href, true), [onLinkPress]);
  const renderImage = useThreadMarkdownImageRenderer({
    onLinkPress,
    textStyle: textStyles.question,
    environmentId: props.environmentId,
    threadId: props.threadId,
    workspaceRoot: props.workspaceRoot,
    setExpandedFile,
  });
  const markdownProps = {
    fileEmbedLabel,
    renderImage,
    onLinkPress,
    onImagePress,
    resolveImageSource,
    marginTop: 0,
    marginBottom: 0,
  };
  const questionCount = props.pendingUserInput.questions.length;
  const canRespond = props.pendingUserInput.responseCapability !== "not_resumable";
  const isResponding = props.respondingUserInputId === props.pendingUserInput.requestId;
  const responseDisabled = !canRespond || isResponding;
  const setDirection = markdownProseDirection(
    props.pendingUserInput.questions
      .flatMap((question) => [
        question.header,
        question.question,
        ...question.options.flatMap((option) => [option.label, option.description ?? ""]),
      ])
      .join(" "),
  );

  const cardCoverage = props.cardCoverage;
  const barHeightRef = useRef(0);
  const cardHeightRef = useRef(0);
  const cardHeight = useSharedValue(0);
  const notifyCoverage = () => {
    if (!cardCoverage) {
      return;
    }
    // The card resizes with the keyboard every frame, so easing each sample would leave the
    // feed inset and floating controls trailing it.
    cardCoverage.set(Math.max(0, cardHeightRef.current - barHeightRef.current));
  };
  const handleBarLayout = (event: LayoutChangeEvent) => {
    barHeightRef.current = event.nativeEvent.layout.height;
    notifyCoverage();
  };
  const handleCardLayout = (event: LayoutChangeEvent) => {
    cardHeightRef.current = event.nativeEvent.layout.height;
    cardHeight.set(event.nativeEvent.layout.height);
    notifyCoverage();
  };
  const cardProgress = props.cardProgress;
  const maxHeight = props.maxHeight;
  const cardAnimatedStyle = useAnimatedStyle(() => {
    const progress = cardProgress === undefined ? 1 : cardProgress.value;
    return {
      maxHeight: maxHeight.value,
      transform: [{ translateY: (1 - progress) * cardHeight.value }],
    };
  });
  const cardMaxHeightStyle = useAnimatedStyle(() => ({ maxHeight: maxHeight.value }));
  const overlayHeightStyle = useAnimatedStyle(() => ({ height: maxHeight.value }));

  // Keep the iOS card mounted so expansion starts on the UI thread without waiting for React layout.
  const renderCard = EXPANDED_CARD_IS_OVERLAY || !props.collapsed;
  const showBar = props.collapsed || EXPANDED_CARD_IS_OVERLAY;
  const bar = showBar ? (
    <View
      onLayout={handleBarLayout}
      pointerEvents={props.collapsed ? "auto" : "none"}
      accessibilityElementsHidden={!props.collapsed}
      importantForAccessibility={props.collapsed ? "auto" : "no-hide-descendants"}
      className="flex-row items-center gap-2 rounded-full border border-border bg-card-alt py-1.5 pl-4 pr-1.5"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Expand user input, ${questionCount} question${
          questionCount === 1 ? "" : "s"
        }`}
        onPress={props.onToggleCollapsed}
        className="min-h-10 flex-1 flex-row items-center gap-2 active:opacity-70"
      >
        <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
          User input needed
        </Text>
        <Text className="font-sans text-xs text-foreground-muted">
          {questionCount} question{questionCount === 1 ? "" : "s"}
        </Text>
        <View className="flex-1" />
        <SymbolView
          name="chevron.up"
          size={12}
          tintColorClassName={"accent-icon-subtle"}
          type="monochrome"
        />
      </Pressable>
      {props.onStopThread ? (
        <ControlPill
          accessibilityLabel="Stop"
          icon="stop.fill"
          variant="danger"
          className="h-9 w-9"
          disabled={!props.canOperateThread}
          onPress={props.onStopThread}
        />
      ) : null}
    </View>
  ) : null;
  const card = renderCard ? (
    <Animated.View
      onLayout={handleCardLayout}
      pointerEvents={props.collapsed ? "none" : "auto"}
      accessibilityElementsHidden={props.collapsed}
      importantForAccessibility={props.collapsed ? "no-hide-descendants" : "auto"}
      entering={
        EXPANDED_CARD_IS_OVERLAY
          ? undefined
          : FadeInUp.duration(USER_INPUT_TOGGLE_DURATION_MS).easing(Easing.out(Easing.cubic))
      }
      exiting={
        EXPANDED_CARD_IS_OVERLAY
          ? undefined
          : FadeOutDown.duration(USER_INPUT_TOGGLE_DURATION_MS).easing(Easing.out(Easing.cubic))
      }
      className="overflow-hidden gap-2.5 rounded-[20px] border border-border bg-card-alt p-4"
      style={EXPANDED_CARD_IS_OVERLAY ? cardAnimatedStyle : cardMaxHeightStyle}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Collapse user input"
        onPress={props.onToggleCollapsed}
        className="flex-row items-start gap-2"
      >
        <View className="flex-1 gap-2.5">
          <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
            User input needed
          </Text>
          <Text className="font-t3-bold text-lg text-foreground">Fill in the pending answers</Text>
        </View>
        <View className="h-8 w-8 items-center justify-center rounded-full bg-subtle-strong">
          <SymbolView
            name="chevron.down"
            size={13}
            tintColorClassName={"accent-icon-subtle"}
            type="monochrome"
          />
        </View>
      </Pressable>
      <ScrollView
        bounces={false}
        className="min-h-0"
        contentContainerClassName="gap-2.5 pb-1"
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        showsVerticalScrollIndicator
        style={{ flexShrink: 1 }}
      >
        {!canRespond ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            The provider process for this request is no longer available. Interrupt or restart the
            run to continue.
          </Text>
        ) : null}
        {questions.map(({ question, spokenFallback }) => {
          const draft = props.drafts[question.id];
          return (
            <View key={question.id} className="gap-2 pt-1">
              <Text
                className="font-t3-bold text-xs uppercase tracking-[1px] text-foreground-muted"
                accessibilityLabel={
                  spokenFallback ? `${question.header}. ${spokenFallback}` : undefined
                }
                style={proseDirectionStyle(question.header, setDirection)}
              >
                {question.header}
              </Text>
              <QuestionText
                environmentId={props.environmentId}
                {...markdownProps}
                markdown={question.question}
                textStyle={textStyles.question}
                setDirection={setDirection}
              />
              <View className="gap-2">
                {question.options.map((option) => {
                  const optionValue = option.value ?? option.label.trim();
                  const selected = isPendingUserInputOptionSelected(question, draft, optionValue);
                  const description =
                    option.description !== option.label ? option.description : undefined;
                  return (
                    <PendingUserInputOption
                      key={JSON.stringify([optionValue, option.label, description])}
                      option={option}
                      setDirection={setDirection}
                      multiSelect={question.multiSelect}
                      selected={selected}
                      disabled={responseDisabled}
                      markdownProps={markdownProps}
                      labelTextStyle={selected ? textStyles.selectedLabel : textStyles.label}
                      descriptionTextStyle={textStyles.description}
                      onOpenTarget={onLinkPress}
                      onSelect={() =>
                        props.onSelectOption(
                          props.pendingUserInput.requestId,
                          question,
                          optionValue,
                        )
                      }
                    />
                  );
                })}
              </View>
              {question.allowCustomAnswer !== false ? (
                <QuestionAttachments
                  key={`${props.pendingUserInput.requestId}:${question.id}`}
                  requestId={props.pendingUserInput.requestId}
                  question={question}
                  questions={props.pendingUserInput.questions}
                  disabled={responseDisabled}
                  value={draft?.customAnswer ?? ""}
                  onChangeText={(value) =>
                    props.onChangeCustomAnswer(props.pendingUserInput.requestId, question.id, value)
                  }
                  onInputFocusChange={props.onInputFocusChange}
                />
              ) : null}
            </View>
          );
        })}
      </ScrollView>
      <Button
        label="Submit answers"
        fullWidth
        tone={props.answers ? "primary" : "secondary"}
        disabled={!props.canOperateThread || responseDisabled || props.answers === null}
        onPress={() => void props.onSubmit()}
      />
      {props.pendingUserInput.dismissible ? (
        <Button
          label="Dismiss without answering"
          tone="text"
          disabled={isResponding}
          onPress={() => void props.onDismiss()}
        />
      ) : null}
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-tertiary">
          This connection cannot submit answers.
        </Text>
      ) : null}
    </Animated.View>
  ) : null;
  return (
    <View className="relative">
      <FilePreviewModal source={expandedFile} onRequestClose={() => setExpandedFile(null)} />
      <VideoPreviewModal source={expandedVideo} onRequestClose={() => setExpandedVideo(null)} />
      {bar}
      <ThreadMediaVisibleContext value={!props.collapsed}>
        {EXPANDED_CARD_IS_OVERLAY ? (
          <Animated.View
            pointerEvents={props.collapsed ? "none" : "box-none"}
            className="absolute inset-x-0 bottom-0 justify-end overflow-hidden"
            style={overlayHeightStyle}
          >
            {card}
          </Animated.View>
        ) : (
          card
        )}
      </ThreadMediaVisibleContext>
    </View>
  );
}

function PendingUserInputOption(props: {
  readonly option: ThreadUserInputQuestion["options"][number];
  readonly setDirection: TextDirection | undefined;
  readonly multiSelect: boolean;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly markdownProps: Pick<
    SelectableMarkdownTextProps,
    | "fileEmbedLabel"
    | "onLinkPress"
    | "onImagePress"
    | "renderImage"
    | "resolveImageSource"
    | "marginTop"
    | "marginBottom"
  >;
  readonly labelTextStyle: SelectableMarkdownTextProps["textStyle"];
  readonly descriptionTextStyle: SelectableMarkdownTextProps["textStyle"];
  readonly onOpenTarget: ReturnType<typeof useThreadMarkdownLinkPress>;
  readonly onSelect: () => void;
}) {
  const description =
    props.option.description !== props.option.label ? props.option.description : undefined;
  const { fileEmbedLabel } = props.markdownProps;
  const content = useMemo(
    () =>
      [props.option.label, ...(description ? [description] : [])].map((markdown) =>
        markdownAccessibility(markdown, fileEmbedLabel),
      ),
    [props.option.label, description, fileEmbedLabel],
  );
  const targets = content
    .flatMap((item) => item.targets)
    .map((target, index) => ({ ...target, name: `open-target-${index}` }));
  return (
    <Pressable
      accessibilityRole={props.multiSelect ? "checkbox" : "radio"}
      accessibilityLabel={content.map((item) => item.label).join(". ")}
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      accessibilityActions={targets.map(({ name, label }, index) => ({
        name,
        label: `Open ${label}${targets.length > 1 ? ` (${index + 1})` : ""}`,
      }))}
      onAccessibilityAction={(event) => {
        const target = targets.find((target) => target.name === event.nativeEvent.actionName);
        if (target) props.onOpenTarget(target.href, target.image);
      }}
      // Pressability suppresses the answer tap after a handled long press.
      onLongPress={() => undefined}
      disabled={props.disabled}
      className={cn(
        "min-h-12 w-full rounded-2xl border px-3.5 py-3",
        props.selected ? "border-primary bg-primary/10" : "border-border bg-input",
      )}
      onPress={props.onSelect}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <SelectableMarkdownText
          {...props.markdownProps}
          markdown={props.option.label}
          textStyle={props.labelTextStyle}
          writingDirection={markdownProseDirection(props.option.label)}
          textAlign={
            Platform.OS === "android" ? undefined : props.setDirection === "rtl" ? "right" : "left"
          }
        />
        {description ? (
          <SelectableMarkdownText
            {...props.markdownProps}
            markdown={description}
            textStyle={props.descriptionTextStyle}
            writingDirection={markdownProseDirection(description)}
            textAlign={
              Platform.OS === "android"
                ? undefined
                : props.setDirection === "rtl"
                  ? "right"
                  : "left"
            }
          />
        ) : null}
      </View>
    </Pressable>
  );
}
