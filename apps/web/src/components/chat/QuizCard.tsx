import { useState } from "react";
import {
  quizAnswerMessage,
  shuffledQuizOptions,
  type QuizCard as QuizCardData,
} from "@t3tools/shared/quizCard";
import { Button } from "../ui/button";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { Textarea } from "../ui/textarea";

export function QuizCardTimelineCard(props: {
  readonly quizCard: QuizCardData;
  readonly seed: string;
  readonly answered: boolean;
  readonly onSendMessage?: ((text: string) => Promise<void>) | undefined;
}) {
  const options = shuffledQuizOptions(props.quizCard, props.seed);
  const [selected, setSelected] = useState<string | null>(null);
  const [confidence, setConfidence] = useState(50);
  const [thinking, setThinking] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revealed = props.answered || submitted;
  const picked = options.find((option) => option.option === selected);
  // A pick that was never sent is not graded.
  const sentPick = submitted ? picked : undefined;
  const submit = async () => {
    if (sending || revealed || props.onSendMessage === undefined || selected === null) return;
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
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card p-4 text-card-foreground">
      <p className="font-medium">{props.quizCard.question}</p>
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
                className="mt-2 w-full"
              />
            </>
          )}
          <label className="mt-3 block text-sm font-medium" htmlFor={`${props.seed}-thinking`}>
            Your thinking (optional)
          </label>
          <Textarea
            id={`${props.seed}-thinking`}
            value={thinking}
            onChange={(event) => setThinking(event.target.value)}
            disabled={sending}
          />
          <div className="mt-3">
            <Button type="button" onClick={submit} disabled={sending || selected === null}>
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
          <p>{props.quizCard.explanation}</p>
          {options
            .filter(
              (option): option is Extract<(typeof options)[number], { wrongIdea: string }> =>
                !option.correct,
            )
            .map((option) => (
              <p key={option.option}>
                <strong>{option.option}:</strong> {option.wrongIdea}
              </p>
            ))}
        </div>
      ) : null}
    </div>
  );
}
