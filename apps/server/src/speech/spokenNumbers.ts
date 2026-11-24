// Realtime voices misread dense digits, such as 35910 as 55910, when they spell numbers themselves.
const ONES =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(
    " ",
  );
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", " thousand", " million", " billion", " trillion"];
const MONTHS =
  "January February March April May June July August September October November December".split(
    " ",
  );
const ORDINAL_ENDS: Record<string, string> = {
  one: "first",
  two: "second",
  three: "third",
  five: "fifth",
  eight: "eighth",
  nine: "ninth",
  twelve: "twelfth",
  y: "ieth",
};
const CURRENCIES: Record<string, string> = { "€": "euros", $: "US dollars", "£": "pounds" };

/** A whole number in words: 41693 is "forty-one thousand six hundred ninety-three". */
function numberWords(value: number): string {
  if (value < 20) return ONES[value]!;
  if (value < 100)
    return TENS[Math.floor(value / 10)]! + (value % 10 ? `-${ONES[value % 10]}` : "");
  if (value < 1000)
    return `${ONES[Math.floor(value / 100)]} hundred${value % 100 ? ` ${numberWords(value % 100)}` : ""}`;
  const groups: string[] = [];
  for (let scale = 0; value > 0; scale++, value = Math.floor(value / 1000))
    if (value % 1000) groups.unshift(numberWords(value % 1000) + SCALES[scale]);
  return groups.join(" ");
}

const digits = (text: string) => [...text].map((digit) => ONES[Number(digit)]).join(" ");
const whole = (text: string) => {
  const value = Number(text.replaceAll(",", ""));
  return value < 1e15 ? numberWords(value) : digits(text.replaceAll(",", ""));
};
const decimal = (text: string) => {
  const [integer, fraction] = text.split(".");
  return fraction ? `${whole(integer || "0")} point ${digits(fraction)}` : whole(integer!);
};
const dotted = (text: string) => text.split(".").map(whole).join(" point ");
const ordinal = (value: number) =>
  numberWords(value).replace(
    /(one|two|three|five|eight|nine|twelve|y)?$/,
    (end) => ORDINAL_ENDS[end] ?? "th",
  );
const year = (value: number) =>
  value % 100 === 0 || (value >= 2000 && value < 2010)
    ? numberWords(value)
    : `${numberWords(Math.floor(value / 100))} ${value % 100 < 10 ? `oh ${ONES[value % 100]}` : numberWords(value % 100)}`;

const NUMBER = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;
// Digits joined to letters, hyphens, slashes or more digits, such as 1.2s, 3-5 or utf-8, stay as
// written: spelling only part of them garbles the rest.
const alone = (pattern: string) =>
  new RegExp(String.raw`(?<![\w.,:/-])(?:${pattern})(?![\w/-]|[.,:]\d)`, "g");

// Specific shapes run first, so an address or a date is never read as separate numbers.
const RULES: ReadonlyArray<readonly [RegExp, (match: string, ...groups: string[]) => string]> = [
  [
    /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g,
    (_, a, b, c, d) => [a, b, c, d].map(whole).join(" dot "),
  ],
  [
    /\b(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g,
    (_, y, m, d) => `the ${ordinal(Number(d))} of ${MONTHS[Number(m) - 1]}, ${year(Number(y))}`,
  ],
  [
    /(?:\b[vV]|@)(\d+(?:\.\d+)+)\b/g,
    (match, version) => `${match[0] === "@" ? " " : ""}version ${dotted(version)}`,
  ],
  [/\b\d+(?:\.\d+){2,}\b/g, dotted],
  [/#(\d+)\b/g, (_, id) => `number ${id.length >= 3 ? digits(id) : whole(id)}`],
  // Long unseparated numbers are identifiers, read digit by digit.
  [
    /\b(\d{5,})((?:\.\d+)*)\b/g,
    (_, id, rest) => [id, ...rest.split(".").slice(1)].map(digits).join(" point "),
  ],
  [
    alone(String.raw`([€$£])\s?(${NUMBER})`),
    (_, symbol, amount) => `${decimal(amount)} ${CURRENCIES[symbol]}`,
  ],
  [alone(String.raw`(${NUMBER})\s?%`), (_, amount) => `${decimal(amount)} percent`],
  [
    alone(String.raw`([01]?\d|2[0-3]):([0-5]\d)`),
    (_, h, m) =>
      `${whole(h)} ${m === "00" ? "o'clock" : m.startsWith("0") ? `oh ${digits(m.slice(1))}` : whole(m)}`,
  ],
  [alone(String.raw`(?:19|20)\d{2}`), (match) => year(Number(match))],
  [alone(NUMBER), decimal],
];

/**
 * Spells numbers, dates, money, versions and IDs as English words. Text that is not English keeps
 * its digits: with the language on auto, any letter outside A to Z marks it as another language.
 */
export function spokenNumbers(text: string, language: string) {
  const english =
    /^en(?:-|$)/i.test(language) || (language === "auto" && !/[^\P{L}A-Za-z]/u.test(text));
  if (!english) return text;
  return RULES.reduce((spoken, [pattern, spell]) => spoken.replace(pattern, spell), text).replace(
    /[ \t]{2,}/g,
    " ",
  );
}
