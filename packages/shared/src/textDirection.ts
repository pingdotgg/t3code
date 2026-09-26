export type TextDirection = "ltr" | "rtl";

const LETTER_CHARACTER = /^\p{Letter}$/u;
const MARK_CHARACTER = /^\p{Mark}$/u;
const RTL_SCRIPT_CHARACTER =
  /^[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\u{10800}-\u{10fff}\u{1e800}-\u{1eeff}]$/u;
// ponytail: bound streaming-render work; raise these only for real text that exceeds the sample.
const MAX_FIRST_LETTER_CODE_POINTS = 8_192;
const MAX_DIRECTION_CODE_POINTS = 512;
const MAX_DIRECTION_WORDS = 32;
const MAX_WORD_SCORE = 4;
const MAX_LEADING_LTR_WORDS = 3;
const MIN_RTL_SCORE = 8;

export function resolveTextDirection(text: string): TextDirection {
  let searchedCodePoints = 0;
  let inspectedCodePoints = 0;
  let fallbackStarted = false;
  let wordCount = 0;
  let rtlScore = 0;
  let totalScore = 0;
  let wordRtlLetters = 0;
  let wordLtrLetters = 0;
  let wordScore = 0;
  let earlyRtlWordSeen = false;

  for (const character of text) {
    if (!fallbackStarted) {
      if (searchedCodePoints === MAX_FIRST_LETTER_CODE_POINTS) return "ltr";
      searchedCodePoints += 1;
      if (!LETTER_CHARACTER.test(character)) continue;
      if (RTL_SCRIPT_CHARACTER.test(character)) return "rtl";
      fallbackStarted = true;
    }

    if (inspectedCodePoints === MAX_DIRECTION_CODE_POINTS || wordCount === MAX_DIRECTION_WORDS)
      break;
    inspectedCodePoints += 1;

    if (LETTER_CHARACTER.test(character)) {
      if (RTL_SCRIPT_CHARACTER.test(character)) wordRtlLetters += 1;
      else wordLtrLetters += 1;
      if (wordScore < MAX_WORD_SCORE) wordScore += 1;
      continue;
    }

    if (MARK_CHARACTER.test(character) && wordScore !== 0) continue;
    if (wordScore === 0) continue;

    wordCount += 1;
    totalScore += wordScore;
    if (wordRtlLetters > wordLtrLetters) {
      rtlScore += wordScore;
      if (wordCount <= MAX_LEADING_LTR_WORDS + 1) earlyRtlWordSeen = true;
    }
    if (wordCount === MAX_LEADING_LTR_WORDS + 1 && !earlyRtlWordSeen) return "ltr";

    wordRtlLetters = 0;
    wordLtrLetters = 0;
    wordScore = 0;
  }

  if (wordScore !== 0 && wordCount < MAX_DIRECTION_WORDS) {
    totalScore += wordScore;
    if (wordRtlLetters > wordLtrLetters) {
      rtlScore += wordScore;
      if (wordCount < MAX_LEADING_LTR_WORDS + 1) earlyRtlWordSeen = true;
    }
  }

  return earlyRtlWordSeen && rtlScore >= MIN_RTL_SCORE && rtlScore * 5 >= totalScore * 3
    ? "rtl"
    : "ltr";
}
