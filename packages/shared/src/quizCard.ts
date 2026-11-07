export const QUIZ_CARD_TOOL_NAME = "quiz_card" as const;
export const QUESTION_CARD_TOOL_NAME = "question_card" as const;

export interface QuestionCard {
  readonly question: string;
}

export type QuizLevel = "remember" | "understand" | "apply" | "analyse";

export interface QuizCard {
  readonly answer: string;
  readonly explanation: string;
  readonly level: QuizLevel;
  readonly question: string;
  readonly wrongOptions: ReadonlyArray<{ readonly option: string; readonly wrongIdea: string }>;
}

export type LessonCard = QuizCard | QuestionCard;

const MAX_ANSWER = 300;
const MAX_QUESTION = 2000;
const MAX_OPTION = 300;
const MAX_WRONG_IDEA = 500;
const MAX_EXPLANATION = 1500;
const MAX_WRONG_OPTIONS = 4;
const MIN_WRONG_OPTIONS = 2;
const MAX_CARD_BYTES = 7_000;
const LEVELS = new Set<QuizLevel>(["remember", "understand", "apply", "analyse"]);

const boundedString = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max
    ? value.trim()
    : undefined;

export function readQuestionCard(value: unknown): QuestionCard | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const question = boundedString((value as Record<string, unknown>).question, MAX_QUESTION);
  return question === undefined ? undefined : { question };
}

export function readQuizCard(value: unknown): QuizCard | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const answer = boundedString(record.answer, MAX_ANSWER);
  const explanation = boundedString(record.explanation, MAX_EXPLANATION);
  const question = boundedString(record.question, MAX_QUESTION);
  const level = record.level;
  const wrongOptions = record.wrongOptions;
  if (
    answer === undefined ||
    explanation === undefined ||
    question === undefined ||
    typeof level !== "string" ||
    !LEVELS.has(level as QuizLevel) ||
    !Array.isArray(wrongOptions) ||
    wrongOptions.length < MIN_WRONG_OPTIONS ||
    wrongOptions.length > MAX_WRONG_OPTIONS
  ) {
    return undefined;
  }
  const parsed = wrongOptions.map((entry) => {
    if (typeof entry !== "object" || entry === null) return undefined;
    const item = entry as Record<string, unknown>;
    const option = boundedString(item.option, MAX_OPTION);
    const wrongIdea = boundedString(item.wrongIdea, MAX_WRONG_IDEA);
    return option === undefined || wrongIdea === undefined ? undefined : { option, wrongIdea };
  });
  if (parsed.some((entry) => entry === undefined)) return undefined;
  return {
    answer,
    explanation,
    level: level as QuizLevel,
    question,
    wrongOptions: parsed as QuizCard["wrongOptions"],
  };
}

export function quizCardProblem(card: QuizCard): string | undefined {
  const options = [card.answer, ...card.wrongOptions.map((entry) => entry.option)];
  if (
    options.some((option) => /all of the above|none of the above|\(recommended\)/i.test(option))
  ) {
    return 'Options must not contain "all of the above", "none of the above", or "(Recommended)".';
  }
  const seen = new Set<string>();
  for (const option of options) {
    const key = option.trim().toLocaleLowerCase();
    if (seen.has(key)) return "Options must be unique (ignoring case and surrounding whitespace).";
    seen.add(key);
  }
  // Tool output metadata sent to clients is capped at 8 KB (toolOutput.ts).
  if (new TextEncoder().encode(JSON.stringify(card)).byteLength > MAX_CARD_BYTES) {
    return "The card is too long: shorten the question, explanation or wrong ideas.";
  }
  return undefined;
}

function hashSeed(seed: string) {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return () => {
    hash += hash << 13;
    hash ^= hash >>> 7;
    hash += hash << 3;
    hash ^= hash >>> 17;
    hash += hash << 5;
    return (hash >>> 0) / 4294967296;
  };
}

export function shuffledQuizOptions(card: QuizCard, seed: string) {
  const random = hashSeed(seed);
  const options = [
    { option: card.answer, correct: true },
    ...card.wrongOptions.map((entry) => ({ ...entry, correct: false })),
  ];
  for (let index = options.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [options[index], options[other]] = [options[other]!, options[index]!];
  }
  return options;
}

export function quizAnswerMessage(input: {
  readonly answer: string | null;
  readonly correct: boolean;
  readonly confidence?: number;
  readonly thinking?: string;
}) {
  const thinking = input.thinking?.trim();
  if (input.answer === null) {
    return `Quiz answer: I don't know.${thinking ? ` My thinking: ${thinking}` : ""}`;
  }
  const result = `Quiz answer: "${input.answer}", ${input.correct ? "right" : "wrong"}.`;
  const confidence = input.confidence === undefined ? "" : ` Confidence: ${input.confidence}%.`;
  return `${result}${confidence}${thinking ? ` My thinking: ${thinking}` : ""}`;
}

/** The grade in a `quizAnswerMessage`, so analytics can count answers without their text. */
export function quizAnswerGrade(text: string): "right" | "wrong" | "unknown" | undefined {
  if (text.startsWith("Quiz answer: I don't know.")) return "unknown";
  // shortcut: an option whose own text holds `", right.` misgrades; quote answers if counts drift.
  const graded = /^Quiz answer: ".*?", (right|wrong)\./s.exec(text)?.[1];
  return graded === "right" || graded === "wrong" ? graded : undefined;
}

// The card's item id rides in the answer text so every client, after reloads, knows which card it answered.
const CARD_ANSWER_TAG = /\n\n\(card (\S+)\)$/;

export function cardAnswerMessage(text: string, cardId: string) {
  return `${text}\n\n(card ${cardId})`;
}

export function answeredCardIds(
  messages: Iterable<{ readonly role: string; readonly text: string }>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const id = message.role === "user" ? CARD_ANSWER_TAG.exec(message.text)?.[1] : undefined;
    if (id !== undefined) ids.add(id);
  }
  return ids;
}
