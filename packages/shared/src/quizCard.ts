export const QUIZ_CARD_TOOL_NAME = "quiz_card" as const;
export const QUESTION_CARD_TOOL_NAME = "question_card" as const;
export const MIN_CARD_REPLY_CHARS = 250;

export type CardPurpose = "opening-check" | "explain-back";

export function cardReplyProblem(input: {
  readonly reply: string;
  readonly purpose?: CardPurpose | undefined;
  readonly shownBefore: number;
}): string | undefined {
  if (
    input.purpose !== undefined ||
    input.shownBefore + input.reply.trim().length >= MIN_CARD_REPLY_CHARS
  ) {
    return undefined;
  }
  return "The learner sees only real message text and this reply; thinking, plans, and anything you wrote while thinking are summarized away and never shown. Write the verdict and the teaching this card tests in full in reply, then call the card again.";
}

export interface QuestionCard {
  /** The tutor's reply to the learner's last answer, shown as its message text before the card. */
  readonly reply?: string;
  readonly purpose?: CardPurpose;
  readonly question: string;
  readonly blanks?: ReadonlyArray<{ readonly answers: ReadonlyArray<string> }>;
  readonly number?: { readonly answer: number; readonly tolerance: number; readonly unit?: string };
}

export type QuizLevel = "remember" | "understand" | "apply" | "analyse";

export interface QuizCard {
  readonly reply?: string;
  readonly purpose?: CardPurpose;
  readonly answer: string;
  readonly explanation: string;
  readonly level: QuizLevel;
  readonly question: string;
  readonly wrongOptions: ReadonlyArray<{ readonly option: string; readonly wrongIdea: string }>;
}

export type LessonCard = QuizCard | QuestionCard;

const MAX_ANSWER = 300;
const MAX_QUESTION = 2000;
const MAX_REPLY = 2000;
const MAX_OPTION = 300;
const MAX_WRONG_IDEA = 500;
const MAX_EXPLANATION = 1500;
const MAX_WRONG_OPTIONS = 4;
const MIN_WRONG_OPTIONS = 2;
const MAX_CARD_BYTES = 7_000;
const MAX_BLANKS = 6;
const MAX_BLANK_ANSWERS = 4;
const MAX_BLANK_ANSWER = 100;
const MAX_NUMBER_UNIT = 40;
const LEVELS = new Set<QuizLevel>(["remember", "understand", "apply", "analyse"]);

const boundedString = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max
    ? value.trim()
    : undefined;
// Tool output metadata sent to clients is capped at 8 KB (toolOutput.ts).
const fitsCardBytes = (card: object) =>
  new TextEncoder().encode(JSON.stringify(card)).byteLength <= MAX_CARD_BYTES;

// A reply the model sent but that doesn't fit is refused, not silently dropped.
function readReply(record: Record<string, unknown>): { reply?: string } | undefined {
  if (record.reply === undefined || (typeof record.reply === "string" && !record.reply.trim()))
    return {};
  const reply = boundedString(record.reply, MAX_REPLY);
  return reply === undefined ? undefined : { reply };
}

function readPurpose(record: Record<string, unknown>): { purpose?: CardPurpose } | undefined {
  if (record.purpose === undefined) return {};
  return record.purpose === "opening-check" || record.purpose === "explain-back"
    ? { purpose: record.purpose }
    : undefined;
}

export function readQuestionCard(value: unknown): QuestionCard | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const question = boundedString(record.question, MAX_QUESTION);
  const reply = readReply(record);
  const purpose = readPurpose(record);
  if (question === undefined || reply === undefined || purpose === undefined) return undefined;
  const hasBlanks = Object.hasOwn(record, "blanks");
  const hasNumber = Object.hasOwn(record, "number");
  if (hasBlanks && hasNumber) return undefined;
  if (hasBlanks) {
    if (
      !Array.isArray(record.blanks) ||
      record.blanks.length < 1 ||
      record.blanks.length > MAX_BLANKS
    ) {
      return undefined;
    }
    const blanks: Array<{ answers: string[] }> = [];
    for (const entry of record.blanks) {
      const answers =
        typeof entry === "object" && entry !== null
          ? (entry as Record<string, unknown>).answers
          : undefined;
      if (!Array.isArray(answers) || answers.length < 1 || answers.length > MAX_BLANK_ANSWERS) {
        return undefined;
      }
      const parsed = answers.map((answer) => boundedString(answer, MAX_BLANK_ANSWER));
      if (!parsed.every((answer) => answer !== undefined)) return undefined;
      blanks.push({ answers: parsed });
    }
    if ((question.match(/_{3,}/g) ?? []).length !== blanks.length) return undefined;
    const card = { ...reply, ...purpose, question, blanks };
    return fitsCardBytes(card) ? card : undefined;
  }
  if (hasNumber) {
    if (typeof record.number !== "object" || record.number === null) return undefined;
    const number = record.number as Record<string, unknown>;
    if (
      typeof number.answer !== "number" ||
      !Number.isFinite(number.answer) ||
      typeof number.tolerance !== "number" ||
      !Number.isFinite(number.tolerance) ||
      number.tolerance < 0
    ) {
      return undefined;
    }
    // Models often send "" for a unitless number.
    const unit = typeof number.unit === "string" ? number.unit.trim() : undefined;
    if (
      (number.unit !== undefined && unit === undefined) ||
      (unit?.length ?? 0) > MAX_NUMBER_UNIT
    ) {
      return undefined;
    }
    const card = {
      ...reply,
      ...purpose,
      question,
      number: { answer: number.answer, tolerance: number.tolerance, ...(unit ? { unit } : {}) },
    };
    return fitsCardBytes(card) ? card : undefined;
  }
  const card = { ...reply, ...purpose, question };
  return fitsCardBytes(card) ? card : undefined;
}

const normalizedAnswer = (value: string) => value.trim().replace(/\s+/g, " ");

// Symbols and units (m vs M, Co vs CO, mPa vs MPa) keep their case: short or mixed-case answers.
export function blankAnswerRight(
  blank: { readonly answers: ReadonlyArray<string> },
  input: string,
) {
  const answer = normalizedAnswer(input);
  return blank.answers.some((accepted) => {
    const expected = normalizedAnswer(accepted);
    return expected.length <= 2 || /.\p{Lu}/u.test(expected)
      ? expected === answer
      : expected.toLocaleLowerCase() === answer.toLocaleLowerCase();
  });
}

export function parseNumberAnswer(input: string): number | undefined {
  const trimmed = input.trim().replace(/\u2212/g, "-");
  if (trimmed.length === 0) return undefined;
  let parsed = Number(trimmed);
  if (Number.isNaN(parsed) && /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)) {
    parsed = Number(trimmed.replace(/,/g, ""));
  } else if (Number.isNaN(parsed) && /^-?\d*,\d+$/.test(trimmed)) {
    parsed = Number(trimmed.replace(",", "."));
  }
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function numberAnswerRight(number: NonNullable<QuestionCard["number"]>, input: string) {
  const parsed = parseNumberAnswer(input);
  // Relative slack only absorbs float error such as 0.1 + 0.2.
  return (
    parsed !== undefined &&
    Math.abs(parsed - number.answer) <= number.tolerance + 1e-9 * Math.abs(number.answer)
  );
}

export function numberAnswerExpected(number: NonNullable<QuestionCard["number"]>) {
  const tolerance = number.tolerance === 0 ? "" : ` ± ${number.tolerance}`;
  return `${number.answer}${tolerance}${number.unit ? ` ${number.unit}` : ""}`;
}

export function readQuizCard(value: unknown): QuizCard | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const answer = boundedString(record.answer, MAX_ANSWER);
  const explanation = boundedString(record.explanation, MAX_EXPLANATION);
  const question = boundedString(record.question, MAX_QUESTION);
  const reply = readReply(record);
  const purpose = readPurpose(record);
  const level = record.level;
  const wrongOptions = record.wrongOptions;
  if (
    answer === undefined ||
    reply === undefined ||
    purpose === undefined ||
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
    ...reply,
    ...purpose,
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
  if (!fitsCardBytes(card)) {
    return "The card is too long: shorten the reply, question, explanation or wrong ideas.";
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

export function blanksAnswerMessage(input: {
  readonly answers: ReadonlyArray<string>;
  readonly card: QuestionCard;
  readonly thinking?: string;
}) {
  const thinking = input.thinking?.trim();
  const results = input.answers.map((answer, index) => {
    const blank = input.card.blanks?.[index];
    return `${index + 1}. "${normalizedAnswer(answer)}", ${blank && blankAnswerRight(blank, answer) ? "right" : "wrong"}`;
  });
  return `Blanks answer: ${results.join("; ")}.${thinking ? ` My thinking: ${thinking}` : ""}`;
}

export function numberAnswerMessage(input: {
  readonly answer: string;
  readonly card: QuestionCard;
  readonly thinking?: string;
}) {
  const thinking = input.thinking?.trim();
  const number = input.card.number;
  const suffix = number?.unit ? ` ${number.unit}` : "";
  const result = `Number answer: "${input.answer}${suffix}", ${number && numberAnswerRight(number, input.answer) ? "right" : "wrong"}.`;
  return `${result}${thinking ? ` My thinking: ${thinking}` : ""}`;
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

export function withoutCardAnswerTag(text: string) {
  return text.replace(CARD_ANSWER_TAG, "");
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
