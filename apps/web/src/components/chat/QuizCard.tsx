import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  blankAnswerRight,
  cardAnswerMessage,
  blanksAnswerMessage,
  numberAnswerMessage,
  numberAnswerExpected,
  numberAnswerRight,
  parseNumberAnswer,
  parseCardAnswer,
  quizAnswerMessage,
  quizRevealWrongIdeas,
  shuffledQuizOptions,
  type LessonCard,
  type QuizCard as QuizCardData,
  type QuestionCard,
} from "@t3tools/shared/quizCard";
import {
  SpeechTextField,
  TextFieldSpeechControls,
  type TextFieldSpeech,
} from "~/speech/useTextFieldSpeech";
import { chooseAudioDestination, useAudioChoice } from "~/speech/voiceConsent";
import { useEnvironment } from "~/state/environments";
import type { EnvironmentId } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { Textarea } from "../ui/textarea";
import { Input } from "../ui/input";

const focusedCardSeeds = new Set<string>();
// The virtualized timeline unmounts a card scrolled out of view; keep the learner's draft.
const thinkingDrafts = new Map<string, string>();

function useThinkingDraft(seed: string) {
  const [thinking, setThinking] = useState(() => thinkingDrafts.get(seed) ?? "");
  const update = (value: string) => {
    thinkingDrafts.set(seed, value);
    setThinking(value);
  };
  return [thinking, update] as const;
}

/** Sends once any dictation in progress has committed to the draft. */
function submitThinking(
  speech: TextFieldSpeech | undefined,
  thinking: string,
  send: (text: string) => void,
) {
  if (speech) speech.submitAfterDictation(send);
  else send(thinking);
}

/** Voice is off per device until chosen; choosing here sends audio to the lesson's environment, as Settings → Voice would. */
function VoiceOptIn(props: { readonly environmentId: EnvironmentId; readonly disabled: boolean }) {
  const choice = useAudioChoice();
  const environment = useEnvironment(props.environmentId);
  const supported = environment?.serverConfig?.environment.capabilities.voiceTranscription === true;
  if ((choice !== null && choice !== "off") || !supported) return null;
  return (
    <div className="mt-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.disabled}
        onClick={() =>
          chooseAudioDestination({ kind: "environment", environmentId: props.environmentId })
        }
      >
        Answer by voice
      </Button>
      <p className="mt-1 text-xs text-muted-foreground">
        Turns on voice input on this device; audio goes to{" "}
        {environment?.label ?? "this environment"} to be transcribed. Turn it off in Settings →
        Voice.
      </p>
    </div>
  );
}

function ThinkingField(props: {
  readonly seed: string;
  readonly environmentId: EnvironmentId | undefined;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly focusTarget: "textarea" | "radio" | "answer";
  readonly children: (speech: TextFieldSpeech | undefined) => ReactNode;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { seed, focusTarget } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the newly mounted card control in the virtualized timeline
  useEffect(() => {
    if (focusedCardSeeds.has(seed)) return;
    // A card that arrives while the learner types elsewhere never grabs focus later.
    focusedCardSeeds.add(seed);
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable)
    ) {
      const value =
        active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
          ? active.value
          : active.textContent;
      if (value?.trim()) return;
    }
    const selector = `[data-quiz-card-seed="${CSS.escape(seed)}"]`;
    const target =
      focusTarget === "radio"
        ? document.querySelector<HTMLElement>(
            `${selector} [role="radio"], ${selector} input[type="radio"]`,
          )
        : focusTarget === "answer"
          ? document.querySelector<HTMLElement>(`${selector} [data-card-answer]`)
          : textareaRef.current;
    target?.focus({ preventScroll: false });
  }, [focusTarget, seed]);
  const render = (speech?: TextFieldSpeech) => (
    <>
      <label className="mt-3 block text-sm font-medium" htmlFor={`${seed}-thinking`}>
        Explain your thinking
      </label>
      <Textarea
        ref={textareaRef}
        id={`${seed}-thinking`}
        aria-label="Explain your thinking"
        rows={5}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        disabled={props.disabled}
        readOnly={speech?.freezesEditor}
      />
      {props.environmentId ? (
        <VoiceOptIn environmentId={props.environmentId} disabled={props.disabled} />
      ) : null}
      {speech ? <TextFieldSpeechControls speech={speech} disabled={props.disabled} /> : null}
      {props.children(speech)}
    </>
  );
  return props.environmentId ? (
    <SpeechTextField
      environmentId={props.environmentId}
      projectId={null}
      ownerKey={`quiz-card:${seed}`}
      text={props.value}
      textareaRef={textareaRef}
      onTextChange={props.onChange}
      disabled={props.disabled}
    >
      {render}
    </SpeechTextField>
  ) : (
    render()
  );
}

function OpenQuestionCard(props: {
  readonly card: QuestionCard;
  readonly seed: string;
  readonly answered: boolean;
  readonly answer?: string | undefined;
  readonly environmentId: EnvironmentId | undefined;
  readonly onSendMessage?: ((text: string) => Promise<void>) | undefined;
}) {
  const [thinking, setThinking] = useThinkingDraft(props.seed);
  const blankCount = props.card.blanks?.length ?? 0;
  const [answers, setAnswers] = useState(() => Array.from({ length: blankCount }, () => ""));
  const [numberAnswer, setNumberAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revealed = props.answered || submitted;
  const numberRight =
    props.card.number !== undefined && numberAnswerRight(props.card.number, numberAnswer);
  const isStructured = props.card.blanks !== undefined || props.card.number !== undefined;
  const answerReady =
    props.card.blanks !== undefined
      ? answers.every((answer) => answer.trim().length > 0)
      : props.card.number !== undefined && parseNumberAnswer(numberAnswer) !== undefined;
  const savedAnswer = props.answer === undefined ? undefined : parseCardAnswer(props.answer);
  const savedBlanks =
    savedAnswer?.kind === "blanks" && savedAnswer.answers.length === blankCount
      ? savedAnswer.answers
      : undefined;
  const savedNumber = savedAnswer?.kind === "number" ? savedAnswer : undefined;
  const send = async (text: string, skip = false) => {
    if (sending || revealed || props.onSendMessage === undefined || text.length === 0) return;
    setSending(true);
    setError(null);
    try {
      await props.onSendMessage(cardAnswerMessage(text, props.seed));
      setSkipped(skip);
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send your answer.");
    }
    setSending(false);
  };
  const submitStructured = (speech: TextFieldSpeech | undefined) => {
    submitThinking(speech, thinking, (submittedThinking) => {
      const text =
        props.card.blanks !== undefined
          ? blanksAnswerMessage({ answers, card: props.card, thinking: submittedThinking })
          : numberAnswerMessage({
              answer: numberAnswer.trim(),
              card: props.card,
              thinking: submittedThinking,
            });
      void send(text);
    });
  };
  const renderQuestion = () => {
    if (props.card.blanks === undefined)
      return <p className="font-medium">{props.card.question}</p>;
    const parts = props.card.question.split(/_{3,}/g);
    return (
      <p className="font-medium leading-9">
        {parts.map((part, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- fixed segments of an immutable card
          <span key={index}>
            {part}
            {index < props.card.blanks!.length ? (
              revealed ? (
                (savedBlanks?.[index]?.answer ?? answers[index])
              ) : (
                <Input
                  data-card-answer={index === 0 ? true : undefined}
                  aria-label={`Blank ${index + 1}`}
                  value={answers[index] ?? ""}
                  onChange={(event) =>
                    setAnswers((current) =>
                      current.map((answer, item) => (item === index ? event.target.value : answer)),
                    )
                  }
                  disabled={sending}
                  size="sm"
                  className="mx-1 inline-block w-32 align-middle"
                />
              )
            ) : null}
          </span>
        ))}
      </p>
    );
  };
  return (
    <div
      data-quiz-card-seed={props.seed}
      className="min-w-0 rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      {renderQuestion()}
      {props.card.number !== undefined && !revealed ? (
        <div className="mt-3 flex items-center gap-2">
          <Input
            data-card-answer
            aria-label="Your answer"
            inputMode="decimal"
            type="text"
            value={numberAnswer}
            onChange={(event) => setNumberAnswer(event.target.value)}
            disabled={revealed || sending}
            className="w-40"
          />
          {props.card.number.unit ? <span>{props.card.number.unit}</span> : null}
          {numberAnswer.trim() && parseNumberAnswer(numberAnswer) === undefined ? (
            <span className="text-sm text-muted-foreground">
              Enter a number, like 9.8 or 6.7e-11
            </span>
          ) : null}
        </div>
      ) : null}
      {props.onSendMessage === undefined && !revealed ? (
        <p className="mt-3 text-sm text-muted-foreground">Answer in the chat</p>
      ) : null}
      {props.onSendMessage !== undefined && !revealed ? (
        <>
          <ThinkingField
            seed={props.seed}
            environmentId={props.environmentId}
            value={thinking}
            onChange={setThinking}
            disabled={sending}
            focusTarget={isStructured ? "answer" : "textarea"}
          >
            {(speech) => (
              <div className="mt-3 flex gap-2">
                <Button
                  type="button"
                  onClick={() =>
                    isStructured
                      ? submitStructured(speech)
                      : submitThinking(speech, thinking, (text) => void send(text.trim()))
                  }
                  disabled={
                    sending ||
                    speech?.preparing ||
                    (isStructured
                      ? !answerReady
                      : !speech?.blocksSubmission && thinking.trim().length === 0)
                  }
                >
                  Send
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void send("I don't know.", true)}
                  disabled={sending}
                >
                  I don't know
                </Button>
              </div>
            )}
          </ThinkingField>
          {error ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
      {revealed ? (
        <div className="mt-4 space-y-2 text-sm">
          {skipped || savedAnswer?.kind === "skipped" ? (
            <p>I don't know.</p>
          ) : props.card.blanks ? (
            props.answered && !submitted && savedBlanks === undefined ? (
              <>
                <p>Answered.</p>
                {props.card.blanks.map((blank, index) => (
                  // oxlint-disable-next-line react/no-array-index-key -- blanks of an immutable card
                  <p key={index}>
                    Blank {index + 1}: {blank.answers.join(" / ")}
                  </p>
                ))}
              </>
            ) : (
              props.card.blanks.map((blank, index) => {
                const answer = savedBlanks?.[index]?.answer ?? answers[index] ?? "";
                const right =
                  savedBlanks?.[index]?.grade === "right" ||
                  (savedBlanks === undefined && blankAnswerRight(blank, answer));
                return (
                  <p
                    // oxlint-disable-next-line react/no-array-index-key -- blanks of an immutable card
                    key={index}
                    className={right ? "text-success" : "text-destructive"}
                  >
                    Blank {index + 1}: {savedBlanks ? `${answer}. ` : ""}
                    {right ? "Right." : "Wrong."} Accepted: {blank.answers.join(" / ")}
                  </p>
                );
              })
            )
          ) : props.card.number ? (
            props.answered && !submitted && savedNumber === undefined ? (
              <>
                <p>Answered.</p>
                <p>Expected {numberAnswerExpected(props.card.number)}</p>
              </>
            ) : (
              <p
                className={
                  savedNumber?.grade === "right" || (savedNumber === undefined && numberRight)
                    ? "text-success"
                    : "text-destructive"
                }
              >
                Your answer:{" "}
                {savedNumber?.answer ??
                  `${numberAnswer.trim()}${props.card.number.unit ? ` ${props.card.number.unit}` : ""}`}
                .{" "}
                {savedNumber?.grade === "right" || (savedNumber === undefined && numberRight)
                  ? "Right."
                  : "Wrong."}{" "}
                Expected {numberAnswerExpected(props.card.number)}
              </p>
            )
          ) : (
            <p>Answered.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function MultipleChoiceCard(props: {
  readonly card: QuizCardData;
  readonly seed: string;
  readonly answered: boolean;
  readonly answer?: string | undefined;
  readonly environmentId: EnvironmentId | undefined;
  readonly onSendMessage?: ((text: string) => Promise<void>) | undefined;
}) {
  const options = shuffledQuizOptions(props.card, props.seed);
  const [selected, setSelected] = useState<string | null>(null);
  const [confidence, setConfidence] = useState(50);
  const [thinking, setThinking] = useThinkingDraft(props.seed);
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revealed = props.answered || submitted;
  const picked = options.find((option) => option.option === selected);
  const parsedAnswer = props.answer === undefined ? undefined : parseCardAnswer(props.answer);
  const savedAnswer = parsedAnswer?.kind === "quiz" ? parsedAnswer : undefined;
  const sentAnswer = submitted
    ? selected === "__unknown__"
      ? null
      : selected
    : savedAnswer?.answer;
  const sentPick =
    sentAnswer === undefined || sentAnswer === null
      ? undefined
      : options.find((option) => option.option === sentAnswer);
  const sentPickCorrect = sentPick?.correct === true;
  const submit = async (text: string) => {
    if (
      sending ||
      revealed ||
      props.onSendMessage === undefined ||
      selected === null ||
      (selected !== "__unknown__" && text.trim().length === 0)
    )
      return;
    setSending(true);
    setError(null);
    try {
      await props.onSendMessage(
        cardAnswerMessage(
          quizAnswerMessage({
            answer: selected === "__unknown__" ? null : selected,
            correct: picked?.correct === true,
            confidence,
            thinking: text,
          }),
          props.seed,
        ),
      );
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send your answer.");
    }
    setSending(false);
  };
  const needsThinking = selected !== "__unknown__";
  const wrongOptions = quizRevealWrongIdeas(options);
  return (
    <div
      data-quiz-card-seed={props.seed}
      className="min-w-0 rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      <p className="font-medium">{props.card.question}</p>
      <RadioGroup
        value={
          selected ?? (savedAnswer?.answer === null ? "__unknown__" : (savedAnswer?.answer ?? ""))
        }
        onValueChange={setSelected}
        disabled={revealed || sending}
        className="mt-3"
      >
        {options.map((option) => (
          <label key={option.option} className="flex items-center gap-2">
            <RadioGroupItem value={option.option} aria-label={option.option} />
            <span>
              {option.option}
              {revealed && option.correct ? " (right)" : ""}
            </span>
          </label>
        ))}
        <label className="flex items-center gap-2">
          <RadioGroupItem value="__unknown__" aria-label="I don't know" />
          <span>I don't know</span>
        </label>
      </RadioGroup>
      {props.onSendMessage === undefined && !revealed ? (
        <p className="mt-3 text-sm text-muted-foreground">Answer in the chat</p>
      ) : null}
      {props.onSendMessage !== undefined && !revealed ? (
        <>
          {selected === "__unknown__" ? null : (
            <>
              <label
                className="mt-4 block text-sm font-medium"
                htmlFor={`${props.seed}-confidence`}
              >
                How sure are you? <span>{confidence}%</span>
              </label>
              <input
                id={`${props.seed}-confidence`}
                aria-label="Confidence"
                type="range"
                min={0}
                max={100}
                value={confidence}
                onChange={(event) => setConfidence(Number(event.target.value))}
                disabled={sending}
                className="mt-2 w-full accent-primary"
              />
            </>
          )}
          <ThinkingField
            seed={props.seed}
            environmentId={props.environmentId}
            value={thinking}
            onChange={setThinking}
            disabled={sending}
            focusTarget="radio"
          >
            {(speech) => (
              <div className="mt-3">
                <Button
                  type="button"
                  onClick={() => submitThinking(speech, thinking, (text) => void submit(text))}
                  disabled={
                    sending ||
                    selected === null ||
                    speech?.preparing ||
                    (needsThinking && !speech?.blocksSubmission && thinking.trim().length === 0)
                  }
                >
                  Submit
                </Button>
              </div>
            )}
          </ThinkingField>
          {error ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
      {revealed ? (
        <div className="mt-4 space-y-2 text-sm">
          <p
            className={
              sentPick === undefined
                ? undefined
                : sentPickCorrect
                  ? "text-success"
                  : "text-destructive"
            }
          >
            {parsedAnswer?.kind === "skipped"
              ? "I don't know."
              : sentAnswer === undefined
                ? "Answered."
                : sentAnswer === null
                  ? "Your answer: I don't know."
                  : sentPickCorrect
                    ? `Your answer: ${sentAnswer}. Right.`
                    : `Your answer: ${sentAnswer}. Wrong.`}
          </p>
          <p>{props.card.explanation}</p>
          {wrongOptions.map((option) => (
            <p key={option.option}>
              <strong>{option.label}</strong> {option.wrongIdea}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function QuizCardTimelineCard(props: {
  readonly quizCard: LessonCard;
  readonly seed: string;
  readonly answered: boolean;
  readonly answer?: string | undefined;
  readonly environmentId?: EnvironmentId | undefined;
  readonly onSendMessage?: ((text: string) => Promise<void>) | undefined;
}) {
  return "answer" in props.quizCard ? (
    <MultipleChoiceCard {...props} card={props.quizCard} environmentId={props.environmentId} />
  ) : (
    <OpenQuestionCard {...props} card={props.quizCard} environmentId={props.environmentId} />
  );
}
