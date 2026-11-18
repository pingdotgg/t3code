// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/desktop-helper/src/computer/decisions.ts), modified for Ada.
import { number, object, string } from "./validate.ts";

/**
 * System One shaped decisions: typed questions about a state, answered with probabilities instead of
 * text, over closed candidate sets. The helper never decides anything itself: its Decider sends the
 * questions to the server, where the decision provider answers them through the same shape.
 */
export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string };

export type Answer =
  | { type: "choice"; choice: string; probability: number }
  | { type: "noul"; probability: number };

/** Answers by question id. A question the provider could not answer is absent. */
export type Answers = Record<string, Answer>;

/** Asks every question about one state at once. Rejects when the server refuses or does not answer. */
export interface Decider {
  ask(state: unknown, questions: Record<string, Question>): Promise<Answers>;
}

/** Checks `answers` from a decision reply; throws on any answer that is not a choice or a noul. */
export function parseAnswers(value: unknown): Answers {
  const answers: Answers = {};
  for (const [id, raw] of Object.entries(object(value, "answers"))) {
    const answer = object(raw, `answers.${id}`);
    const probability = number(answer.probability, `answers.${id}.probability`);
    if (probability < 0 || probability > 1)
      throw new Error(`answers.${id}.probability should be from 0 to 1`);
    if (answer.type === "choice")
      answers[id] = {
        type: "choice",
        choice: string(answer.choice, `answers.${id}.choice`),
        probability,
      };
    else if (answer.type === "noul") answers[id] = { type: "noul", probability };
    else throw new Error(`answers.${id}.type should be choice or noul`);
  }
  return answers;
}

/** The probability a Choice gave one option (0 when it chose another, or did not answer). */
export function choiceProbability(answers: Answers, id: string, option: string): number {
  const answer = answers[id];
  return answer?.type === "choice" && answer.choice === option ? answer.probability : 0;
}
