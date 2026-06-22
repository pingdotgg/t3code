import type { RuntimeRequestId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";
<<<<<<< HEAD
import {
  isPendingUserInputOptionSelected,
  type PendingUserInput,
  type PendingUserInputDraftAnswer,
} from "../../lib/threadActivity";
=======
import type { PendingUserInput, PendingUserInputDraftAnswer } from "../../lib/threadActivity";
>>>>>>> aedd7c58a2 (Complete orchestration V2 frontend cutover)

export interface PendingUserInputCardProps {
  readonly pendingUserInput: PendingUserInput;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly answers: Record<string, string> | null;
  readonly respondingUserInputId: RuntimeRequestId | null;
  readonly onSelectOption: (requestId: RuntimeRequestId, questionId: string, label: string) => void;
  readonly onChangeCustomAnswer: (
    requestId: RuntimeRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmit: () => Promise<unknown>;
}

export function PendingUserInputCard(props: PendingUserInputCardProps) {
<<<<<<< HEAD
  const questionCount = props.pendingUserInput.questions.length;

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
      className="flex-row items-center gap-2 rounded-full border border-adaptive-neutral-200-white-a6 bg-adaptive-neutral-100-900 py-1.5 pl-4 pr-1.5"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Expand user input, ${questionCount} question${
          questionCount === 1 ? "" : "s"
        }`}
        onPress={props.onToggleCollapsed}
        className="min-h-10 flex-1 flex-row items-center gap-2 active:opacity-70"
      >
        <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-adaptive-sky-700-300">
          User input needed
        </Text>
        <Text className="font-sans text-xs text-adaptive-neutral-500-400">
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
      className="overflow-hidden gap-2.5 rounded-[20px] border border-adaptive-neutral-200-white-a6 bg-adaptive-neutral-100-900 p-4"
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
          <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-adaptive-sky-700-300">
            User input needed
          </Text>
          <Text className="font-t3-bold text-lg text-adaptive-neutral-950-50">
            Fill in the pending answers
          </Text>
        </View>
        <View className="h-8 w-8 items-center justify-center rounded-full bg-adaptive-neutral-200-a70-white-a8">
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
        {props.pendingUserInput.questions.map((question) => {
          const draft = props.drafts[question.id];
          return (
            <View key={question.id} className="gap-2 pt-1">
              <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-neutral-500">
                {question.header}
              </Text>
              <Text className="font-sans text-base leading-snug text-adaptive-neutral-950-50">
                {question.question}
              </Text>
              <View className="gap-2">
                {question.options.map((option) => {
                  const selected = isPendingUserInputOptionSelected(draft, option.label);
                  const description =
                    option.description !== option.label ? option.description : undefined;
                  return (
                    <Pressable
                      key={option.label}
=======
<<<<<<< HEAD
  // The surface is opaque on purpose: the card floats over the thread feed
  // with no blur behind it, so a translucent background renders the questions
  // on top of whatever message happens to sit underneath.
=======
  const canRespond = props.pendingUserInput.responseCapability === "live";
>>>>>>> 79c36e6204 (Complete orchestration V2 frontend cutover)
  return (
    <View className="gap-2.5 rounded-[20px] border border-neutral-200 bg-neutral-100 p-4 dark:border-white/6 dark:bg-neutral-900">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-sky-700 dark:text-sky-300">
        User input needed
      </Text>
      <Text className="font-t3-bold text-lg text-neutral-950 dark:text-neutral-50">
        Fill in the pending answers
      </Text>
      {!canRespond ? (
        <Text className="font-sans text-sm leading-5 text-neutral-600 dark:text-neutral-400">
          The provider process for this request is no longer available. Interrupt or restart the run
          to continue.
        </Text>
      ) : null}
      {props.pendingUserInput.questions.map((question) => {
        const draft = props.drafts[question.id];
        return (
          <View key={question.id} className="gap-2 pt-1">
            <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-neutral-500 dark:text-neutral-500">
              {question.header}
            </Text>
            <Text className="font-sans text-base leading-snug text-neutral-950 dark:text-neutral-50">
              {question.question}
            </Text>
            <View className="flex-row flex-wrap gap-2.5">
              {question.options.map((option) => {
                const selected =
                  draft?.selectedOptionLabel === option.label && !draft.customAnswer?.trim().length;
                return (
                  <Pressable
                    key={option.label}
                    disabled={!canRespond}
                    className={cn(
                      "rounded-full border px-3 py-2.5 ",
                      selected
                        ? "border-blue-300/50 bg-blue-50 dark:border-blue-400/28 dark:bg-blue-400/14"
                        : "border-neutral-200 bg-white dark:border-white/6 dark:bg-neutral-950/70",
                    )}
                    onPress={() =>
                      props.onSelectOption(
                        props.pendingUserInput.requestId,
                        question.id,
                        option.label,
                      )
                    }
                  >
                    <Text
>>>>>>> aedd7c58a2 (Complete orchestration V2 frontend cutover)
                      className={cn(
                        "font-t3-bold text-sm",
                        selected
<<<<<<< HEAD
                          ? "border-adaptive-blue-300-a50-blue-400-a28 bg-adaptive-blue-50-blue-400-a14"
                          : "border-adaptive-neutral-200-white-a6 bg-adaptive-white-neutral-950-a70",
=======
                          ? "text-sky-700 dark:text-sky-300"
                          : "text-neutral-600 dark:text-neutral-300",
>>>>>>> aedd7c58a2 (Complete orchestration V2 frontend cutover)
                      )}
                    >
<<<<<<< HEAD
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Text
                          className={cn(
                            "font-t3-bold text-sm",
                            selected
                              ? "text-adaptive-sky-700-300"
                              : "text-adaptive-neutral-600-300",
                          )}
                        >
                          {option.label}
                        </Text>
                        {description ? (
                          <Text className="font-sans text-sm leading-5 text-adaptive-neutral-500-400">
                            {description}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
              <TextInput
                value={draft?.customAnswer ?? ""}
                onChangeText={(value) =>
                  props.onChangeCustomAnswer(props.pendingUserInput.requestId, question.id, value)
                }
                onFocus={() => props.onInputFocusChange?.(true)}
                onBlur={() => props.onInputFocusChange?.(false)}
                placeholder="Or type a custom answer"
                className="min-h-[54px] rounded-2xl border border-adaptive-neutral-200-white-a8 bg-adaptive-white-neutral-950-a70 px-3.5 py-3 font-sans text-base text-adaptive-neutral-950-50"
              />
=======
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
>>>>>>> aedd7c58a2 (Complete orchestration V2 frontend cutover)
            </View>
            <TextInput
              editable={canRespond}
              value={draft?.customAnswer ?? ""}
              onChangeText={(value) =>
                props.onChangeCustomAnswer(props.pendingUserInput.requestId, question.id, value)
              }
              placeholder="Or type a custom answer"
              className="min-h-[54px] rounded-2xl border border-neutral-200 bg-white px-3.5 py-3 font-sans text-base text-neutral-950 dark:border-white/8 dark:bg-neutral-950/70 dark:text-neutral-50"
            />
          </View>
        );
      })}
      <Pressable
        className={cn(
          "items-center justify-center rounded-2xl px-4 py-3.5",
          props.answers ? "bg-blue-500" : "bg-adaptive-neutral-200-700-a60",
        )}
        disabled={
          !canRespond ||
          props.answers === null ||
          props.respondingUserInputId === props.pendingUserInput.requestId
        }
        onPress={() => void props.onSubmit()}
      >
        <Text className="font-t3-extrabold text-sm text-white">Submit answers</Text>
      </Pressable>
    </View>
  );
}
