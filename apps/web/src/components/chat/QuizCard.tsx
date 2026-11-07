import { useEffect, useRef, useState } from "react";
import {
  quizAnswerMessage,
  shuffledQuizOptions,
  type LessonCard,
  type QuizCard as QuizCardData,
} from "@t3tools/shared/quizCard";
import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import type { EnvironmentId } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { Textarea } from "../ui/textarea";

const focusedCardSeeds = new Set<string>();

type SpeechTextareaProps = {
  readonly seed: string;
  readonly environmentId: EnvironmentId | undefined;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly focusTarget: "textarea" | "radio";
};

function useCardFocus(
  seed: string,
  focusTarget: SpeechTextareaProps["focusTarget"],
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the newly mounted card control in the virtualized timeline
  useEffect(() => {
    if (focusedCardSeeds.has(seed)) return;
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
    focusedCardSeeds.add(seed);
    const selector = `[data-quiz-card-seed="${CSS.escape(seed)}"]`;
    const target =
      focusTarget === "radio"
        ? document.querySelector<HTMLElement>(
            `${selector} [role="radio"], ${selector} input[type="radio"]`,
          )
        : textareaRef.current;
    target?.focus({ preventScroll: false });
  }, [focusTarget, seed, textareaRef]);
}

function PlainTextarea(props: SpeechTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useCardFocus(props.seed, props.focusTarget, textareaRef);
  return (
    <>
      <label className="mt-3 block text-sm font-medium" htmlFor={`${props.seed}-thinking`}>
        Explain your thinking
      </label>
      <Textarea
        ref={textareaRef}
        id={`${props.seed}-thinking`}
        aria-label="Explain your thinking"
        rows={5}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        disabled={props.disabled}
      />
    </>
  );
}

function DictatedTextarea(props: SpeechTextareaProps & { readonly environmentId: EnvironmentId }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const speech = useTextFieldSpeech({
    environmentId: props.environmentId,
    projectId: null,
    ownerKey: `quiz-card:${props.seed}`,
    text: props.value,
    textareaRef,
    onTextChange: props.onChange,
    disabled: props.disabled,
  });
  useCardFocus(props.seed, props.focusTarget, textareaRef);
  return (
    <>
      <label className="mt-3 block text-sm font-medium" htmlFor={`${props.seed}-thinking`}>
        Explain your thinking
      </label>
      <Textarea
        ref={textareaRef}
        id={`${props.seed}-thinking`}
        aria-label="Explain your thinking"
        rows={5}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        disabled={props.disabled}
        readOnly={speech.freezesEditor}
      />
      <TextFieldSpeechControls speech={speech} disabled={props.disabled} />
    </>
  );
}

function SpeechTextarea(props: SpeechTextareaProps) {
  return props.environmentId ? (
    <DictatedTextarea {...props} environmentId={props.environmentId} />
  ) : (
    <PlainTextarea {...props} />
  );
}

function OpenQuestionCard(props: {
  readonly card: { readonly question: string };
  readonly seed: string;
  readonly answered: boolean;
  readonly environmentId: EnvironmentId | undefined;
  readonly onSendMessage?: ((text: string) => Promise<void>) | undefined;
}) {
  const [thinking, setThinking] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revealed = props.answered || submitted;
  const send = async (text: string) => {
    if (sending || revealed || props.onSendMessage === undefined) return;
    setSending(true);
    setError(null);
    try {
      await props.onSendMessage(text);
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send your answer.");
    }
    setSending(false);
  };
  return (
    <div
      data-quiz-card-seed={props.seed}
      className="min-w-0 rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      <p className="font-medium">{props.card.question}</p>
      {props.onSendMessage === undefined && !revealed ? (
        <p className="mt-3 text-sm text-muted-foreground">Answer in the chat</p>
      ) : null}
      {props.onSendMessage !== undefined && !revealed ? (
        <>
          <SpeechTextarea
            seed={props.seed}
            environmentId={props.environmentId}
            value={thinking}
            onChange={setThinking}
            disabled={sending}
            focusTarget="textarea"
          />
          <div className="mt-3 flex gap-2">
            <Button
              type="button"
              onClick={() => void send(thinking.trim())}
              disabled={sending || thinking.trim().length === 0}
            >
              Send
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void send("I don't know.")}
              disabled={sending}
            >
              I don't know
            </Button>
          </div>
          {error ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
      {revealed ? <p className="mt-4 text-sm">Answered.</p> : null}
    </div>
  );
}

function MultipleChoiceCard(props: {
  readonly card: QuizCardData;
  readonly seed: string;
  readonly answered: boolean;
  readonly environmentId: EnvironmentId | undefined;
  readonly onSendMessage?: ((text: string) => Promise<void>) | undefined;
}) {
  const options = shuffledQuizOptions(props.card, props.seed);
  const [selected, setSelected] = useState<string | null>(null);
  const [confidence, setConfidence] = useState(50);
  const [thinking, setThinking] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revealed = props.answered || submitted;
  const picked = options.find((option) => option.option === selected);
  const sentPick = submitted ? picked : undefined;
  const submit = async () => {
    if (
      sending ||
      revealed ||
      props.onSendMessage === undefined ||
      selected === null ||
      (selected !== "__unknown__" && thinking.trim().length === 0)
    )
      return;
    setSending(true);
    setError(null);
    try {
      await props.onSendMessage(
        quizAnswerMessage({
          answer: selected === "__unknown__" ? null : selected,
          correct: picked?.correct === true,
          confidence,
          thinking,
        }),
      );
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send your answer.");
    }
    setSending(false);
  };
  const needsThinking = selected !== "__unknown__";
  const wrongOptions = options.filter(
    (option): option is Extract<(typeof options)[number], { wrongIdea: string }> => !option.correct,
  );
  return (
    <div
      data-quiz-card-seed={props.seed}
      className="min-w-0 rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      <p className="font-medium">{props.card.question}</p>
      <RadioGroup
        value={selected ?? ""}
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
          <SpeechTextarea
            seed={props.seed}
            environmentId={props.environmentId}
            value={thinking}
            onChange={setThinking}
            disabled={sending}
            focusTarget="radio"
          />
          <div className="mt-3">
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={
                sending || selected === null || (needsThinking && thinking.trim().length === 0)
              }
            >
              Submit
            </Button>
          </div>
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
                : sentPick.correct
                  ? "text-success"
                  : "text-destructive"
            }
          >
            {sentPick === undefined
              ? submitted
                ? "I don't know."
                : "Answered."
              : sentPick.correct
                ? "Right."
                : "Wrong."}
          </p>
          <p>{props.card.explanation}</p>
          {wrongOptions.map((option) => (
            <p key={option.option}>
              <strong>{option.option}:</strong> {option.wrongIdea}
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
  readonly environmentId?: EnvironmentId | undefined;
  readonly onSendMessage?: ((text: string) => Promise<void>) | undefined;
}) {
  return "answer" in props.quizCard ? (
    <MultipleChoiceCard {...props} card={props.quizCard} environmentId={props.environmentId} />
  ) : (
    <OpenQuestionCard {...props} card={props.quizCard} environmentId={props.environmentId} />
  );
}
