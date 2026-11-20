import { Button } from "../../components/ui/Button";
import type { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import type { ThreadUserInputQuestion } from "@t3tools/client-runtime/state/thread-requests";
import {
  markdownProseDirection,
  textDirection,
  type TextDirection,
} from "@t3tools/shared/textDirection";
import { useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import Animated, { useAnimatedStyle, type DerivedValue } from "react-native-reanimated";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { markdownPreviewText } from "./markdownPreview";
import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import {
  fileRoutePathSegments,
  resolveFileLinkPath,
  resolveWorkspaceRelativeFilePath,
} from "../files/filePath";
import { useLiveThreadLinkLabels } from "../../state/entities";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  isPendingUserInputOptionSelected,
  resolvePendingUserInputAnswer,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import type { PendingUserInput } from "../../lib/threadActivity";
import { THREAD_CARD_FACE_CLASS_NAME } from "./ThreadCardFace";

const SHEET_RADIUS = 28;
const SCROLL_FADE_HEIGHT = 24;
// The text actions have no padding of their own, so the row can end flush with the highlights.
const ACTION_HIT_SLOP = { top: 12, bottom: 12, left: 10, right: 10 };
// A pill ends at the panel's 8pt edge; a trailing text button ends at the 20pt text edge instead.
const TEXT_ACTION_LAST_MARGIN = 12;

/** The 16px solid check, drawn for small sizes; the 24px glyph turns hairline when scaled down this far. */
function SmallCheck(props: { readonly color: string }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 16 16" fill={props.color}>
      <Path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z"
      />
    </Svg>
  );
}

/** Fades scrolled-away content into the panel's fill, so it is not sliced at the scroll edge. */
function ScrollEdgeFade(props: { readonly edge: "top" | "bottom"; readonly color: string }) {
  const id = `question-fade-${props.edge}`;
  const solid = props.edge === "top" ? 0 : 1;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        height: SCROLL_FADE_HEIGHT,
        [props.edge]: 0,
      }}
    >
      <Svg width="100%" height={SCROLL_FADE_HEIGHT}>
        <Defs>
          <LinearGradient
            id={id}
            x1="0"
            y1="0"
            x2="0"
            y2={SCROLL_FADE_HEIGHT}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0" stopColor={props.color} stopOpacity={1 - solid} />
            <Stop offset="1" stopColor={props.color} stopOpacity={solid} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

export interface PendingUserInputCardProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
  readonly canOperateThread: boolean;
  readonly pendingUserInput: PendingUserInput;
  /** What the agent wrote just before asking; shown below the question. */
  readonly contextMarkdown?: string | undefined;
  /** The text in the prompt box, which answers the current question once sent. */
  readonly typedAnswer?: string | undefined;
  readonly maxHeight: DerivedValue<number>;
  /** The question being answered; the prompt box answers it too. */
  readonly step: number;
  readonly onStepChange: (step: number) => void;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly respondingUserInputId: RuntimeRequestId | null;
  /** Every question has an answer, so the last step can send. */
  readonly canSubmit: boolean;
  readonly onSubmit: () => Promise<unknown>;
  readonly onSelectOption: (
    requestId: RuntimeRequestId,
    question: ThreadUserInputQuestion,
    value: string,
  ) => void;
  readonly onDismiss: () => Promise<unknown>;
}

/** Desktop waits this long after a single-choice pick, so the pick is seen before the step moves. */
export const AUTO_ADVANCE_MS = 200;

function proseDirectionStyle(text: string, setDirection: TextDirection | undefined) {
  const direction = textDirection(text);
  return {
    ...(direction ? { direction, writingDirection: direction } : null),
    textAlign: (direction === "rtl") === (setDirection === "rtl") ? "left" : "right",
  } as const;
}

/** Agents mark their pick with a trailing "(Recommended)" in the label; the row shows it as a tag. */
function splitRecommended(label: string) {
  const match = /^(.*\S)\s*[([]\s*recommended\s*[)\]]\s*$/i.exec(label);
  return match?.[1] ? { text: match[1], recommended: true } : { text: label, recommended: false };
}

const CONTEXT_CLAMP_LINES = 3;

function QuestionText(props: {
  readonly markdown: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
  readonly setDirection: TextDirection | undefined;
  readonly preserveSoftBreaks?: boolean;
  /** The agent's earlier text: a size smaller, in the muted color. */
  readonly muted?: boolean;
}) {
  const styles = useMarkdownPreviewStyles();
  const markdown = useLiveThreadLinkLabels(props.markdown, props.environmentId);
  const navigation = useNavigation();
  const openPullRequest = useOpenPullRequest();
  const openLink = (href: string) => {
    const link = resolveMarkdownLinkPresentation(href);
    if (link.kind !== "file") {
      void openPullRequest(href);
      return;
    }
    const path = resolveFileLinkPath(props.workspaceRoot, link.path);
    if (path === null) return;
    navigation.navigate("ThreadFile", {
      environmentId: String(props.environmentId),
      threadId: String(props.threadId),
      path: fileRoutePathSegments(
        resolveWorkspaceRelativeFilePath(props.workspaceRoot, path) ?? path,
      ),
      ...(link.line ? { line: String(link.line) } : {}),
    });
  };
  return (
    <SelectableMarkdownText
      markdown={markdown}
      textStyle={props.muted ? styles.mutedNativeTextStyle : styles.nativeTextStyle}
      writingDirection={markdownProseDirection(markdown)}
      // Android's renderer aligns relative to each paragraph's direction.
      textAlign={
        Platform.OS === "android" ? undefined : props.setDirection === "rtl" ? "right" : "left"
      }
      onLinkPress={openLink}
      preserveSoftBreaks={props.preserveSoftBreaks}
    />
  );
}

/** What the agent wrote just before asking: muted, three lines with an inline "Show more". */
function AgentContext(props: {
  readonly markdown: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
  readonly setDirection: TextDirection | undefined;
}) {
  const gt = useGT();
  const styles = useMarkdownPreviewStyles();
  const font = styles.mutedNativeTextStyle;
  const textStyle = {
    color: font.color,
    fontFamily: font.fontFamily,
    fontSize: font.fontSize,
    lineHeight: font.lineHeight,
  };
  const preview = markdownPreviewText(props.markdown);
  // The preview's wrapped lines and the width of "… Show more", measured off screen at the
  // panel's width. The ellipsis is placed by hand: the native text cannot clamp lines.
  const [lines, setLines] = useState<ReadonlyArray<{ text: string; width: number }> | null>(null);
  const [moreWidth, setMoreWidth] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const overflowing = lines !== null && lines.length > CONTEXT_CLAMP_LINES;

  const clamped = (() => {
    if (!overflowing) return null;
    const visible = lines
      .slice(0, CONTEXT_CLAMP_LINES)
      .map((line) => line.text.replace(/\s+$/, ""));
    const last = lines[CONTEXT_CLAMP_LINES - 1]!;
    const lastText = visible[CONTEXT_CLAMP_LINES - 1]!;
    const charWidth = last.width / Math.max(1, lastText.length);
    const free = containerWidth - last.width;
    const chop = free >= moreWidth ? 0 : Math.ceil((moreWidth - free) / charWidth) + 1;
    const keep = Math.max(0, lastText.length - chop);
    let cut = lastText.slice(0, keep);
    // End on a whole word with no dangling punctuation: "trade-off… Show more", never "off:…".
    if (chop > 0 && !/\s/.test(lastText.charAt(keep))) cut = cut.replace(/\s+\S*$/, "");
    visible[CONTEXT_CLAMP_LINES - 1] = cut.replace(/[\s:;,.\-–—]+$/, "");
    return visible;
  })();

  const toggle = (label: string) => (
    <Text
      accessibilityRole="button"
      onPress={props.onToggle}
      className="font-t3-medium text-foreground"
      style={{ fontSize: font.fontSize }}
    >
      {label}
    </Text>
  );
  return (
    <View onLayout={(event) => setContainerWidth(event.nativeEvent.layout.width)}>
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ position: "absolute", left: 0, right: 0, top: 0, opacity: 0 }}
      >
        <Text style={textStyle} onTextLayout={(event) => setLines(event.nativeEvent.lines)}>
          {preview}
        </Text>
        <Text
          style={[textStyle, { alignSelf: "flex-start" }]}
          onLayout={(event) => setMoreWidth(event.nativeEvent.layout.width)}
        >
          {"… "}
          {gt("Show more")}
        </Text>
      </View>
      {props.expanded || (lines !== null && !overflowing) ? (
        <View className="gap-1">
          <QuestionText
            markdown={props.markdown}
            environmentId={props.environmentId}
            threadId={props.threadId}
            workspaceRoot={props.workspaceRoot}
            setDirection={props.setDirection}
            preserveSoftBreaks
            muted
          />
          {props.expanded && overflowing ? (
            <View className="self-start">{toggle(gt("Show less"))}</View>
          ) : null}
        </View>
      ) : clamped ? (
        <Text style={textStyle}>
          {clamped.join("\n")}
          {"… "}
          {toggle(gt("Show more"))}
        </Text>
      ) : (
        <Text style={textStyle} numberOfLines={CONTEXT_CLAMP_LINES}>
          {preview}
        </Text>
      )}
    </View>
  );
}

/** A radio (single choice) or a checkbox (several). Explicit radii: iOS's continuous corners would squircle a circle. */
function SelectionMark(props: {
  readonly selected: boolean;
  readonly multiple: boolean;
  readonly checkColor: string;
}) {
  return (
    <View
      className={cn(
        "h-5 w-5 items-center justify-center",
        props.selected ? "bg-primary" : "border-[1.5px] border-foreground-tertiary",
      )}
      style={{ borderRadius: props.multiple ? 6 : 10, borderCurve: "circular" }}
    >
      {props.selected ? (
        props.multiple ? (
          <SmallCheck color={props.checkColor} />
        ) : (
          <View
            className="h-2 w-2 bg-primary-foreground"
            style={{ borderRadius: 4, borderCurve: "circular" }}
          />
        )
      ) : null}
    </View>
  );
}

function OptionRow(props: {
  readonly selected: boolean;
  readonly multiple: boolean;
  readonly disabled: boolean;
  readonly dimmed: boolean;
  readonly accessibilityLabel?: string;
  readonly checkColor: string;
  /** Sits on its own line above the title, so the mark lines up with the title, not the badge. */
  readonly badge?: ReactNode;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole={props.multiple ? "checkbox" : "radio"}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ borderRadius: 16, borderCurve: "continuous", paddingVertical: 14 }}
      className={cn(
        "gap-1.5 px-3",
        props.selected ? "bg-foreground/6" : "active:bg-foreground/5",
        props.dimmed && "opacity-50",
      )}
    >
      {/* Indented to the title column: mark width (20) + gap (12). */}
      {props.badge ? <View className="flex-row pl-8">{props.badge}</View> : null}
      <View className="flex-row items-start gap-3">
        <View className="h-5 justify-center">
          <SelectionMark
            selected={props.selected}
            multiple={props.multiple}
            checkColor={props.checkColor}
          />
        </View>
        <View className="min-w-0 flex-1 gap-1">{props.children}</View>
      </View>
    </Pressable>
  );
}

export function PendingUserInputCard(props: PendingUserInputCardProps) {
  const gt = useGT();
  const { questions, requestId } = props.pendingUserInput;
  const questionCount = questions.length;
  const step = Math.max(0, Math.min(props.step, questionCount - 1));
  const question = questions[step];
  const canRespond = props.pendingUserInput.responseCapability !== "not_resumable";
  const isResponding = props.respondingUserInputId === requestId;
  const dimmed = !canRespond || !props.canOperateThread;
  const responseDisabled = dimmed || isResponding;
  const [contextExpanded, setContextExpanded] = useState(false);
  // Which edges have content scrolled out of view; their fades show only then.
  const [hiddenEdges, setHiddenEdges] = useState({ top: false, bottom: false });
  const scrollMetrics = useRef({ questionId: "", offset: 0, content: 0, viewport: 0 });
  const { themeVariables: colors } = useAppearancePreferences();
  const fadeColor = colors["--color-card-face"];
  const checkColor = colors["--color-primary-foreground"];
  const stepQuestionId = props.pendingUserInput.questions[props.step]?.id;
  const updateHiddenEdges = (next: Partial<typeof scrollMetrics.current>) => {
    const metrics = scrollMetrics.current;
    // A new step's scroll view starts at its top.
    if (metrics.questionId !== stepQuestionId) {
      metrics.questionId = stepQuestionId ?? "";
      metrics.offset = 0;
    }
    Object.assign(metrics, next);
    const top = metrics.offset > 1;
    const bottom = metrics.offset + metrics.viewport < metrics.content - 1;
    setHiddenEdges((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  };
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The step whose pick is about to move on; its Next button stays hidden meanwhile.
  const [advancingStep, setAdvancingStep] = useState<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels a pending auto-advance when the card unmounts
  useEffect(
    () => () => {
      if (advanceTimer.current !== null) clearTimeout(advanceTimer.current);
    },
    [],
  );
  const heightStyle = useAnimatedStyle(() => ({ maxHeight: props.maxHeight.value }));
  if (!question) return null;

  const isLast = step === questionCount - 1;
  const draft = props.drafts[question.id];
  const hasOptions = question.options.length > 0;
  // What is typed in the prompt box shows at once as "Your answer"; sending it makes it the answer.
  const anyPicked = question.options.some((option) =>
    isPendingUserInputOptionSelected(question, draft, option.value ?? option.label.trim()),
  );
  const typed =
    question.allowCustomAnswer === false || (!question.multiSelect && anyPicked)
      ? ""
      : (props.typedAnswer ?? "");
  const storedCustom = question.allowCustomAnswer === false ? "" : (draft?.customAnswer ?? "");
  const customAnswer = typed.trim().length > 0 ? typed : storedCustom;
  const customActive =
    question.initialAnswer !== undefined ? customAnswer.length > 0 : customAnswer.trim().length > 0;
  const attachmentCount = draft?.attachmentCount ?? 0;
  const answered = resolvePendingUserInputAnswer(question, draft) !== null;
  const contextMarkdown = props.contextMarkdown;
  const setDirection = markdownProseDirection(
    [
      contextMarkdown ?? "",
      question.question,
      ...question.options.flatMap((option) => [option.label, option.description ?? ""]),
    ].join(" "),
  );

  const select = (optionValue: string) => {
    void Haptics.selectionAsync();
    props.onSelectOption(requestId, question, optionValue);
    if (question.multiSelect || isLast) return;
    if (advanceTimer.current !== null) clearTimeout(advanceTimer.current);
    setAdvancingStep(step);
    advanceTimer.current = setTimeout(() => {
      advanceTimer.current = null;
      setAdvancingStep(null);
      props.onStepChange(step + 1);
    }, AUTO_ADVANCE_MS);
  };
  const goToStep = (next: number) => {
    void Haptics.selectionAsync();
    // A step change of the user's own cancels a pick's pending auto-advance.
    if (advanceTimer.current !== null) clearTimeout(advanceTimer.current);
    advanceTimer.current = null;
    setAdvancingStep(null);
    props.onStepChange(next);
  };
  const showNext = !isLast && advancingStep !== step && (question.multiSelect || answered);
  const showSend = isLast && props.canSubmit;
  const showBack = step > 0;
  const lastIsText = !showSend && !showNext;
  const skipIsLast = props.pendingUserInput.dismissible && lastIsText && !showBack;
  const backIsLast = showBack && lastIsText;
  const lastTextMargin = { marginRight: TEXT_ACTION_LAST_MARGIN } as const;

  return (
    <Animated.View
      // 20pt text inset on the left, the 8pt corner edge on the right and the bottom.
      className={cn(THREAD_CARD_FACE_CLASS_NAME, "gap-2 pb-2 pl-5 pr-2 pt-4")}
      // Sheet-like: the composer's large continuous corners, not the 10pt of inline cards.
      style={[{ borderRadius: SHEET_RADIUS, borderCurve: "continuous" }, heightStyle]}
    >
      {/* One content column from the 8pt edge on both sides. Text sits 12pt in (the 20pt inset); option
          highlights extend back out to the edge; the scroll view clips at its own frame. */}
      <View className="-ml-3 min-h-0 shrink">
        <ScrollView
          // A new step starts at its top.
          key={question.id}
          bounces={false}
          className="min-h-0"
          scrollEventThrottle={16}
          onScroll={(event) => updateHiddenEdges({ offset: event.nativeEvent.contentOffset.y })}
          onContentSizeChange={(_, height) => updateHiddenEdges({ content: height })}
          onLayout={(event) => updateHiddenEdges({ viewport: event.nativeEvent.layout.height })}
          contentContainerClassName="gap-2 px-3 pb-1"
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          showsVerticalScrollIndicator
          style={{ flexShrink: 1 }}
        >
          <QuestionText
            markdown={question.question}
            environmentId={props.environmentId}
            threadId={props.threadId}
            workspaceRoot={props.workspaceRoot}
            setDirection={setDirection}
            preserveSoftBreaks
          />
          {contextMarkdown ? (
            <AgentContext
              markdown={contextMarkdown}
              expanded={contextExpanded}
              onToggle={() => setContextExpanded((current) => !current)}
              environmentId={props.environmentId}
              threadId={props.threadId}
              workspaceRoot={props.workspaceRoot}
              setDirection={setDirection}
            />
          ) : null}
          {hasOptions || customActive ? (
            // 4pt more than the text gap: the highlight has no text leading, so the visible gaps match.
            <View className="-mx-3 mt-1 gap-0.5">
              {question.options.map((option) => {
                const optionValue = option.value ?? option.label.trim();
                const selected = isPendingUserInputOptionSelected(question, draft, optionValue);
                const description =
                  option.description !== option.label ? option.description : undefined;
                const { text: label, recommended } = splitRecommended(option.label);
                return (
                  <View key={optionValue}>
                    <OptionRow
                      selected={selected}
                      multiple={question.multiSelect}
                      disabled={responseDisabled}
                      dimmed={dimmed}
                      checkColor={checkColor}
                      badge={
                        recommended ? (
                          <View className="rounded-full bg-primary/15 px-2 py-px">
                            <Text
                              className="font-t3-medium text-primary-text"
                              style={{ fontSize: 13, lineHeight: 17 }}
                            >
                              {gt("Recommended")}
                            </Text>
                          </View>
                        ) : null
                      }
                      onPress={() => select(optionValue)}
                    >
                      <Text
                        className="font-t3-medium text-foreground"
                        style={[
                          { fontSize: 14, lineHeight: 19 },
                          proseDirectionStyle(label, setDirection),
                        ]}
                      >
                        {label}
                      </Text>
                      {description ? (
                        <Text
                          className="text-foreground-muted"
                          style={[
                            { fontSize: 13, lineHeight: 16 },
                            proseDirectionStyle(description, setDirection),
                          ]}
                        >
                          {description}
                        </Text>
                      ) : null}
                    </OptionRow>
                    {option.preview ? (
                      <View className="pb-3 pl-11 pr-3">
                        <QuestionText
                          markdown={option.preview}
                          environmentId={props.environmentId}
                          threadId={props.threadId}
                          workspaceRoot={props.workspaceRoot}
                          setDirection={setDirection}
                          preserveSoftBreaks
                        />
                      </View>
                    ) : null}
                  </View>
                );
              })}
              {/* An answer typed in the prompt box stands in for the options. */}
              {customActive ? (
                <OptionRow
                  selected
                  multiple={question.multiSelect}
                  disabled
                  dimmed={dimmed}
                  checkColor={checkColor}
                  onPress={() => {}}
                >
                  <Text
                    className="font-t3-medium text-foreground-muted"
                    style={{ fontSize: 12, lineHeight: 16 }}
                  >
                    {gt("Your answer")}
                  </Text>
                  <Text
                    className="text-foreground"
                    style={[
                      { fontSize: 14, lineHeight: 19 },
                      proseDirectionStyle(customAnswer, setDirection),
                    ]}
                  >
                    {customAnswer}
                  </Text>
                </OptionRow>
              ) : null}
            </View>
          ) : null}
          {attachmentCount > 0 ? (
            <Text className="text-xs text-foreground-muted">
              {gt(
                "{count, plural, one {{count} attachment with your answer} other {{count} attachments with your answer}}",
                { count: attachmentCount },
              )}
            </Text>
          ) : null}
        </ScrollView>
        {hiddenEdges.top ? <ScrollEdgeFade edge="top" color={fadeColor} /> : null}
        {hiddenEdges.bottom ? <ScrollEdgeFade edge="bottom" color={fadeColor} /> : null}
      </View>
      {!canRespond ? (
        <Text className="text-xs leading-4 text-foreground-muted">
          {gt(
            "The provider process for this request is no longer available. Interrupt or restart the run to continue.",
          )}
        </Text>
      ) : !props.canOperateThread ? (
        <Text className="text-xs leading-4 text-foreground-muted">
          {gt("This connection cannot submit answers.")}
        </Text>
      ) : null}
      {questionCount > 1 ||
      step > 0 ||
      props.pendingUserInput.dismissible ||
      showNext ||
      showSend ? (
        // The progress keeps the 20pt text inset; a last pill ends at the 8pt edge, a last text button at the text edge.
        <View className="min-h-10 flex-row items-center gap-5">
          {questionCount > 1 ? (
            <Text className="text-foreground-muted" style={{ fontSize: 13, lineHeight: 17 }}>
              {gt("{current} of {total}", { current: step + 1, total: questionCount })}
            </Text>
          ) : null}
          <View className="flex-1" />
          {props.pendingUserInput.dismissible ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Skip question without answering")}
              accessibilityState={{ disabled: isResponding || !props.canOperateThread }}
              disabled={isResponding || !props.canOperateThread}
              onPress={() => void props.onDismiss()}
              hitSlop={ACTION_HIT_SLOP}
              style={skipIsLast ? lastTextMargin : undefined}
              className="active:opacity-70"
            >
              <Text
                style={{ fontSize: 14, lineHeight: 19 }}
                className={cn(
                  "font-t3-medium",
                  isResponding || !props.canOperateThread
                    ? "text-foreground-muted"
                    : "text-foreground-secondary",
                )}
              >
                {gt("Skip")}
              </Text>
            </Pressable>
          ) : null}
          {showBack ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Previous question")}
              disabled={isResponding}
              onPress={() => goToStep(step - 1)}
              hitSlop={ACTION_HIT_SLOP}
              style={backIsLast ? lastTextMargin : undefined}
              className="active:opacity-70"
            >
              <Text
                className="font-t3-medium text-foreground-secondary"
                style={{ fontSize: 14, lineHeight: 19 }}
              >
                {gt("Back")}
              </Text>
            </Pressable>
          ) : null}
          {showSend ? (
            <Button
              label={gt("Send")}
              accessibilityLabel={gt("Send answers")}
              tone="primary"
              size="compact"
              loading={isResponding}
              disabled={responseDisabled}
              onPress={() => void props.onSubmit()}
            />
          ) : null}
          {showNext ? (
            <Button
              label={gt("Next")}
              accessibilityLabel={gt("Next question")}
              tone="primary"
              size="compact"
              disabled={!answered || responseDisabled}
              onPress={() => goToStep(step + 1)}
            />
          ) : null}
        </View>
      ) : null}
    </Animated.View>
  );
}
