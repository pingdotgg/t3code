const MAX_CHARS = 700;
const DIGIT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];
const SMALL_NUMBER_WORDS: readonly string[] = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS_WORDS: readonly string[] = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];
const SCALE_WORDS = ["", "thousand", "million", "billion", "trillion", "quadrillion"];

function speakDigits(value: string): string {
  return value
    .split("")
    .map((digit) => DIGIT_WORDS[Number(digit)])
    .join(" ");
}

function speakUnderThousand(value: number): string {
  const words: string[] = [];
  if (value >= 100) {
    const hundreds = SMALL_NUMBER_WORDS[Math.floor(value / 100)];
    words.push(String(hundreds), "hundred");
    value %= 100;
  }
  if (value >= 20) {
    const tens = TENS_WORDS[Math.floor(value / 10)];
    words.push(String(tens));
    value %= 10;
  }
  if (value > 0) {
    const small = SMALL_NUMBER_WORDS[value];
    words.push(String(small));
  }
  return words.join(" ");
}

function speakInteger(value: string): string {
  const digits = value.replaceAll(",", "").replace(/^0+(?=\d)/, "");
  if (digits === "0") return "zero";
  const groups: number[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    groups.push(Number(digits.slice(Math.max(0, end - 3), end)));
  }
  if (groups.length > SCALE_WORDS.length) return speakDigits(digits);
  const words: string[] = [];
  for (let scale = groups.length - 1; scale >= 0; scale -= 1) {
    const group = groups[scale];
    if (!group) continue;
    words.push(`${speakUnderThousand(group)}${SCALE_WORDS[scale] ? ` ${SCALE_WORDS[scale]}` : ""}`);
  }
  return words.join(" ");
}

function speakDecimal(sign: string, integer: string, fraction: string, percent: string): string {
  return `${sign ? "minus " : ""}${speakInteger(integer)} point ${speakDigits(fraction)}${percent ? " percent" : ""}`;
}

function speakMoney(sign: string, integer: string, fraction: string): string {
  if (fraction.length > 2) return `${speakDecimal(sign, integer, fraction, "")} dollars`;
  const dollars = BigInt(integer.replaceAll(",", ""));
  const cents = Number(fraction.padEnd(2, "0"));
  const words: string[] = [];
  if (dollars > 0n || cents === 0)
    words.push(`${speakInteger(integer)} ${dollars === 1n ? "dollar" : "dollars"}`);
  if (cents > 0) words.push(`${speakInteger(String(cents))} ${cents === 1 ? "cent" : "cents"}`);
  return `${sign ? "minus " : ""}${words.join(" and ")}`;
}

function toSpeakable(text: string): string {
  let t = text;

  t = t.replaceAll(/```[\s\S]*?```/g, " (code omitted) ");
  t = t.replaceAll(/`([^`]+)`/g, "$1");
  t = t.replaceAll(/!\[[^\]]*\]\([^)]*\)/g, " ");
  t = t.replaceAll(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  t = t.replaceAll(/https?:\/\/\S+/g, " (link) ");
  const integer = String.raw`(?:\d{1,3}(?:,\d{3})*|\d+)`;
  const decimalEnd = String.raw`(?!\d|\.\d|[eE][+-]?\d)`;
  t = t.replaceAll(
    new RegExp(String.raw`(?<![\d.])(-?)\$(-?)(${integer})\.(\d+)${decimalEnd}`, "g"),
    (_match, before: string, after: string, whole: string, fraction: string) =>
      speakMoney(before || after, whole, fraction),
  );
  t = t.replaceAll(
    new RegExp(String.raw`(?<![\d.])(-?)\.(\d+)(%?)${decimalEnd}`, "g"),
    (_match, sign: string, fraction: string, percent: string) =>
      speakDecimal(sign, "0", fraction, percent),
  );
  t = t.replaceAll(
    new RegExp(String.raw`(?<![\d.])(-?)(${integer})\.(\d+)(%?)${decimalEnd}`, "g"),
    (_match, sign: string, whole: string, fraction: string, percent: string) =>
      speakDecimal(sign, whole, fraction, percent),
  );
  t = t.replaceAll(/\p{Extended_Pictographic}\uFE0F?/gu, " ");
  t = t.replaceAll(/^#{1,6}\s+/gm, "");
  t = t.replaceAll(/^[\s]*[-*+]\s+/gm, "");
  t = t.replaceAll(/[*_~]{1,3}/g, "");
  t = t.replaceAll(/\s+/g, " ").trim();

  return t;
}

/** Plain sentences to read aloud one at a time, so the first starts before the rest are ready. */
export function toSpeakableSentences(text: string): string[] {
  const whole = toSpeakable(text);
  if (!whole) return [];
  return whole.split(/(?<=[.!?])\s+/).flatMap(splitLongSentence);
}

function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= MAX_CHARS) return [sentence];
  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > MAX_CHARS) {
    const cut = rest.lastIndexOf(" ", MAX_CHARS);
    const at = cut > 0 ? cut : MAX_CHARS;
    pieces.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
}
