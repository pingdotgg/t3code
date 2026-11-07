import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  cardAnswerMessage,
  quizAnswerMessage,
  shuffledQuizOptions,
  type LessonCard,
  type QuizCard as QuizCardData,
} from "@t3tools/shared/quizCard";
import {
  SpeechTextField,
  TextFieldSpeechControls,
  type TextFieldSpeech,
} from "~/speech/useTextFieldSpeech";
import { chooseAudioDestination, useAudioGrant } from "~/speech/voiceConsent";
import { useEnvironment } from "~/state/environments";
import type { EnvironmentId } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { Textarea } from "../ui/textarea";

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
  const grant = useAudioGrant();
  const environment = useEnvironment(props.environmentId);
  const supported = environment?.serverConfig?.environment.capabilities.voiceTranscription === true;
  if (grant !== null || !supported) return null;
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
  readonly focusTarget: "textarea" | "radio";
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
  readonly card: { readonly question: string };
  readonly seed: string;
  readonly answered: boolean;
  readonly environmentId: EnvironmentId | undefined;
  readonly onSendMessage?: ((text: string) => Promise<void>) | undefined;
}) {
  const [thinking, setThinking] = useThinkingDraft(props.seed);
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revealed = props.answered || submitted;
  const send = async (text: string) => {
    if (sending || revealed || props.onSendMessage === undefined || text.length === 0) return;
    setSending(true);
    setError(null);
    try {
      await props.onSendMessage(cardAnswerMessage(text, props.seed));
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
          <ThinkingField
            seed={props.seed}
            environmentId={props.environmentId}
            value={thinking}
            onChange={setThinking}
            disabled={sending}
            focusTarget="textarea"
          >
            {(speech) => (
              <div className="mt-3 flex gap-2">
                <Button
                  type="button"
                  onClick={() => submitThinking(speech, thinking, (text) => void send(text.trim()))}
                  disabled={
                    sending ||
                    speech?.preparing ||
                    (!speech?.blocksSubmission && thinking.trim().length === 0)
                  }
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
            )}
          </ThinkingField>
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
  const [thinking, setThinking] = useThinkingDraft(props.seed);
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revealed = props.answered || submitted;
  const picked = options.find((option) => option.option === selected);
  const sentPick = submitted ? picked : undefined;
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
