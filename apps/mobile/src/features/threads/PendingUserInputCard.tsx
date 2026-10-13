import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import type { SelectableMarkdownTextProps } from "../../native/SelectableMarkdownText.types";
import type { DocumentAssetsEvent } from "react-native-enriched-markdown";
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
import { RequestActionButton } from "./RequestActionButton";
import { QuestionAttachments } from "./QuestionAttachments";
import type { EnvironmentId, ThreadId, RuntimeRequestId } from "@t3tools/contracts";
import type { ThreadUserInputQuestion } from "@t3tools/client-runtime/state/thread-requests";
import { useCallback, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  FadeInUp,
  FadeOutDown,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { USER_INPUT_TOGGLE_DURATION_MS } from "./pendingUserInputLayout";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import { toString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";
import { parseMarkdownDocument } from "../../lib/markdownDocument";
import {
  isPendingUserInputOptionSelected,
  type PendingUserInput,
  type PendingUserInputDraftAnswer,
} from "../../lib/threadActivity";

export interface PendingUserInputCardProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
  readonly canOperateThread: boolean;
  readonly pendingUserInput: PendingUserInput;
  /**
   * Constant while a request is pending (it reserves keyboard space), so the
   * keyboard transition is pure translation; changes only on rare discrete
   * corrections, which the layout transition smooths.
   */
  readonly maxHeight: number;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  /** Renders a stop control on the collapsed bar, which replaces the composer. */
  readonly onStopThread?: () => void;
  /**
   * 0 collapsed → 1 expanded. Slides the iOS overlay card down behind the
   * collapsed bar (inside a clipping window) on the UI thread; the host
   * animates it directly from the tap handler so the card and the feed
   * inset glide start the same frame.
   */
  readonly cardProgress?: SharedValue<number>;
  /**
   * Receives how far the expanded card extends above the bar footprint
   * (written from onLayout with no re-render); the host adds it to the
   * thread feed's end inset so the end of the chat stays visible above the
   * card.
   */
  readonly cardCoverage?: SharedValue<number>;
  /** Fires on custom-answer focus/blur; hosts use it to vet stale keyboard state. */
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
  /** Closes an async question without a reply. Hidden for native callback questions. */
  readonly onDismiss: () => Promise<unknown>;
}

/**
 * On iOS the collapsed bar is the PERMANENT in-flow footprint — the expanded
 * card is an absolutely-positioned overlay rising above it. The overlay's
 * measured height (which drives the thread feed's bottom inset) therefore
 * never changes on collapse/expand, so the transcript stays perfectly still
 * while the card animates over it.
 *
 * Android cannot use the overlay: it does not hit-test touches outside a
 * parent's bounds, which made everything above the bar-sized wrapper
 * untouchable. There the expanded card renders in-flow instead (the wrapper
 * grows with it, and the host skips the coverage inset since the measured
 * overlay already includes the card).
 */
const EXPANDED_CARD_IS_OVERLAY = Platform.OS === "ios";

const CARD_LAYOUT_TRANSITION = LinearTransition.duration(200);

export function PendingUserInputCard(props: PendingUserInputCardProps) {
  const questions = useMemo(
    () =>
      props.pendingUserInput.questions.map((question) => ({
        question,
        spokenFallback: toString(parseMarkdownDocument(question.question)).trim()
          ? undefined
          : question.question,
      })),
    [props.pendingUserInput.questions],
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
    environmentId: props.environmentId,
    threadId: props.threadId,
    workspaceRoot: props.workspaceRoot,
    setExpandedFile,
  });
  const markdownProps = {
    renderImage,
    onLinkPress,
    onImagePress,
    resolveImageSource,
    marginTop: 0,
    marginBottom: 0,
  };
  const questionCount = props.pendingUserInput.questions.length;
  // Message responses start a new run and remain available after the provider exits.
  const canRespond = props.pendingUserInput.responseCapability !== "not_resumable";
  const isResponding = props.respondingUserInputId === props.pendingUserInput.requestId;
  const responseDisabled = !canRespond || isResponding;

  const cardCoverage = props.cardCoverage;
  const barHeightRef = useRef(0);
  const cardHeightRef = useRef(0);
  // Measured card height, written straight from onLayout: the collapse slide
  // distance. Not animated — it only changes on discrete relayouts.
  const cardHeight = useSharedValue(0);
  const notifyCoverage = useCallback(() => {
    if (!cardCoverage) {
      return;
    }
    const coverage = Math.max(0, cardHeightRef.current - barHeightRef.current);
    if (coverage === cardCoverage.value) {
      return;
    }
    if (cardCoverage.value === 0) {
      // First measurement lands while the list is doing its initial
      // end-pin (thread opened onto a pending request); animating it from
      // zero would move the end anchor out from under that scroll.
      cardCoverage.value = coverage;
      return;
    }
    // Animated so a coverage change at rest (discrete max-height
    // corrections) glides the feed instead of stepping it; toggle timing is
    // owned by the host's progress values.
    cardCoverage.value = withTiming(coverage, {
      duration: USER_INPUT_TOGGLE_DURATION_MS,
      easing: Easing.out(Easing.cubic),
    });
  }, [cardCoverage]);
  const handleBarLayout = useCallback(
    (event: LayoutChangeEvent) => {
      barHeightRef.current = event.nativeEvent.layout.height;
      notifyCoverage();
    },
    [notifyCoverage],
  );
  const handleCardLayout = useCallback(
    (event: LayoutChangeEvent) => {
      cardHeightRef.current = event.nativeEvent.layout.height;
      cardHeight.value = event.nativeEvent.layout.height;
      notifyCoverage();
    },
    [cardHeight, notifyCoverage],
  );
  const cardProgress = props.cardProgress;
  // No opacity: fading an opaque card over the live transcript reads as a
  // crossfade (card text, transcript, and bar all half-visible at once).
  // Instead the card stays opaque and slides its full height down past the
  // clipping window's bottom edge, so the transcript is only revealed where
  // the card has physically left.
  const cardAnimatedStyle = useAnimatedStyle(() => {
    const progress = cardProgress === undefined ? 1 : cardProgress.value;
    return {
      transform: [{ translateY: (1 - progress) * cardHeight.value }],
    };
  });

  // On iOS the card stays MOUNTED while collapsed (hidden via the animated
  // style): expanding animates existing views on the UI thread the same
  // frame the host starts the progress timing, instead of paying a React
  // mount + layout before anything moves.
  const renderCard = EXPANDED_CARD_IS_OVERLAY || !props.collapsed;
  const showBar = props.collapsed || EXPANDED_CARD_IS_OVERLAY;
  // The bar renders UNDER the card (earlier in JSX), always opaque: while
  // expanded the opaque card covers it, and during the collapse slide the
  // card's top edge wipes past and reveals it — no opacity handoff, so no
  // crossfade frames.
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
    // The surface is opaque on purpose: the card floats over the thread
    // feed with no blur behind it, so a translucent background renders
    // the questions on top of whatever message happens to sit underneath.
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
      layout={CARD_LAYOUT_TRANSITION}
      className="overflow-hidden gap-2.5 rounded-[20px] border border-border bg-card-alt p-4"
      style={
        EXPANDED_CARD_IS_OVERLAY
          ? [{ maxHeight: props.maxHeight }, cardAnimatedStyle]
          : { maxHeight: props.maxHeight }
      }
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
              >
                {question.header}
              </Text>
              <SelectableMarkdownText
                {...markdownProps}
                markdown={question.question}
                textStyle={textStyles.question}
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
      <RequestActionButton
        label="Submit answers"
        size="large"
        tone={props.answers ? "primary" : "secondary"}
        disabled={!props.canOperateThread || responseDisabled || props.answers === null}
        onPress={() => void props.onSubmit()}
      />
      {props.pendingUserInput.dismissible ? (
        <Pressable
          accessibilityRole="button"
          className="items-center justify-center rounded-2xl px-4 py-2.5 active:opacity-70"
          disabled={isResponding}
          onPress={() => void props.onDismiss()}
        >
          <Text className="font-t3-bold text-sm text-foreground-muted">
            Dismiss without answering
          </Text>
        </Pressable>
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
          // Clipping window for the collapse slide: same footprint as the
          // expanded card, bottom edge on the bar's bottom edge. The sliding
          // card exits through the bottom edge instead of drawing over the
          // composer area, wiping the bar (and the transcript) into view.
          <View
            pointerEvents={props.collapsed ? "none" : "box-none"}
            className="absolute inset-x-0 bottom-0 justify-end overflow-hidden"
            style={{ height: props.maxHeight }}
          >
            {card}
          </View>
        ) : (
          card
        )}
      </ThreadMediaVisibleContext>
    </View>
  );
}

function PendingUserInputOption(props: {
  readonly option: ThreadUserInputQuestion["options"][number];
  readonly multiSelect: boolean;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly markdownProps: Pick<
    SelectableMarkdownTextProps,
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
  const [labelAssets, setLabelAssets] = useState<DocumentAssetsEvent["assets"]>([]);
  const [descriptionAssets, setDescriptionAssets] = useState<DocumentAssetsEvent["assets"]>([]);
  const onLabelAssets = useCallback(
    ({ assets }: DocumentAssetsEvent) => setLabelAssets(assets),
    [],
  );
  const onDescriptionAssets = useCallback(
    ({ assets }: DocumentAssetsEvent) => setDescriptionAssets(assets),
    [],
  );
  const description =
    props.option.description !== props.option.label ? props.option.description : undefined;
  const label = useMemo(
    () =>
      [props.option.label, ...(description ? [description] : [])]
        .map((markdown) => {
          const document = parseMarkdownDocument(markdown);
          visit(document, "break", (_node, index, parent) => {
            if (parent && index !== undefined)
              parent.children[index] = { type: "text", value: " " };
          });
          const blocks: string[] = [];
          visit(document, ["paragraph", "heading", "tableCell", "code"], (node) => {
            blocks.push(toString(node));
          });
          return blocks.join(" ").replace(/\s+/g, " ").trim() || markdown.trim();
        })
        .join(". "),
    [props.option.label, description],
  );
  const targets = useMemo(
    () =>
      [...labelAssets, ...descriptionAssets].map((asset, index) => ({
        asset,
        name: `open-target-${index}`,
        label: `Open ${asset.altText || asset.title || asset.url}`,
      })),
    [labelAssets, descriptionAssets],
  );
  return (
    <Pressable
      accessibilityRole={props.multiSelect ? "checkbox" : "radio"}
      accessibilityLabel={label}
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      accessibilityActions={targets.map(({ name, label }) => ({ name, label }))}
      onAccessibilityAction={(event) => {
        const target = targets.find((target) => target.name === event.nativeEvent.actionName);
        if (target) props.onOpenTarget(target.asset.url, target.asset.kind === "image");
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
          onDocumentAssets={onLabelAssets}
        />
        {description ? (
          <SelectableMarkdownText
            {...props.markdownProps}
            markdown={description}
            textStyle={props.descriptionTextStyle}
            onDocumentAssets={onDescriptionAssets}
          />
        ) : null}
      </View>
    </Pressable>
  );
}
