import type { ServerProviderSkill } from "@t3tools/contracts";

export type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

const SKILL_TOKEN_REGEX =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

export function* matchInlineSkills<Skill extends InlineSkill>(
  text: string,
  skills: readonly Skill[],
) {
  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const name = match[2] ?? "";
    const skill = skills.find((candidate) => candidate.name === name);
    if (!skill) continue;
    const start = match.index + (match[1]?.length ?? 0);
    yield { start, end: match.index + match[0].length, skill, rawText: `$${name}` };
  }
}

const SPOKEN_SKILL_MAX_WORDS = 4;
// Singular only: "my refactoring skills" is ordinary speech, not a skill reference.
const SPOKEN_SKILL_ANCHORS = new Set(["skill"]);
const SPOKEN_SKILL_PREFIXES = new Set(["dollar"]);

const spokenLetters = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Edit distance between two short strings, capped early once it exceeds `limit`. */
function boundedEditDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/** The skill whose spoken form best matches `spoken`, allowing a small typo budget. */
function closestSpokenSkill<T extends InlineSkill>(spoken: string, skills: readonly T[]) {
  let best: { skill: T; distance: number } | null = null;
  for (const skill of skills) {
    for (const form of [skill.name, formatProviderSkillDisplayName(skill)]) {
      const target = spokenLetters(form);
      if (target.length === 0) continue;
      // One slip per six letters: "potato mode" still finds poteto-mode.
      const limit = Math.floor(target.length / 6);
      const distance = boundedEditDistance(spoken, target, limit);
      if (distance <= limit && (best === null || distance < best.distance)) {
        best = { skill, distance };
      }
    }
  }
  return best;
}

/**
 * Turns spoken skill references in a dictated transcript into `$name` tokens,
 * which the composer renders as skill chips. Only phrases anchored by the word
 * "skill" ("the review skill", "skill review") or "dollar" ("dollar review")
 * are rewritten, so ordinary words that happen to name a skill stay text. A
 * leading "the" is folded into the token, and punctuation touching the
 * rewritten phrase is dropped so the token still parses.
 */
export function replaceSpokenSkills(text: string, skills: readonly InlineSkill[]): string {
  if (skills.length === 0) return text;
  const words = [...text.matchAll(/\S+/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    letters: spokenLetters(match[0]),
  }));
  const replacements: { start: number; end: number; token: string }[] = [];
  let consumedUntil = 0;

  const bestSpan = (from: number, step: 1 | -1) => {
    let best: { skill: InlineSkill; distance: number; first: number; last: number } | null = null;
    let spoken = "";
    for (let count = 1; count <= SPOKEN_SKILL_MAX_WORDS; count++) {
      const index = from + step * (count - 1);
      const word = words[index];
      if (!word || word.start < consumedUntil || word.letters.length === 0) break;
      spoken = step === 1 ? spoken + word.letters : word.letters + spoken;
      const match = closestSpokenSkill(spoken, skills);
      // Spans grow word by word, so on a tie the longer name wins ("fix bug" over "bug").
      if (match && (best === null || match.distance <= best.distance)) {
        best = {
          ...match,
          first: step === 1 ? from : index,
          last: step === 1 ? index : from,
        };
      }
    }
    return best;
  };

  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word.start < consumedUntil) continue;
    let match: { skill: InlineSkill; first: number; last: number } | null = null;
    if (SPOKEN_SKILL_ANCHORS.has(word.letters)) {
      const before = bestSpan(index - 1, -1);
      const after = before ? null : bestSpan(index + 1, 1);
      if (before) match = { ...before, last: index };
      else if (after) match = { ...after, first: index };
    } else if (SPOKEN_SKILL_PREFIXES.has(word.letters)) {
      const after = bestSpan(index + 1, 1);
      if (after) match = { ...after, first: index };
    }
    if (!match) continue;
    const first = words[match.first - 1]?.letters === "the" ? match.first - 1 : match.first;
    if (words[first]!.start < consumedUntil) continue;
    replacements.push({
      start: words[first]!.start,
      end: words[match.last]!.end,
      token: `$${match.skill.name}`,
    });
    consumedUntil = words[match.last]!.end;
    index = match.last;
  }

  let result = "";
  let cursor = 0;
  for (const { start, end, token } of replacements) {
    result += text.slice(cursor, start) + token;
    cursor = end;
  }
  return result + text.slice(cursor);
}

/**
 * Adds a space after a known `$skill` token that ends right at `cursor`, so a
 * caret left there does not reopen the skill menu and the token renders as a
 * chip. Used after inserting dictated text, whose trailing space is trimmed.
 */
export function closeSkillTokenAtCursor(
  text: string,
  cursor: number,
  skills: readonly InlineSkill[],
): { readonly text: string; readonly cursor: number } {
  const name = /(?:^|\s)\$([a-zA-Z0-9][a-zA-Z0-9:_-]*)$/.exec(text.slice(0, cursor))?.[1];
  const next = text[cursor];
  if (!name || (next !== undefined && /\s/.test(next))) return { text, cursor };
  if (!skills.some((skill) => skill.name === name)) return { text, cursor };
  return { text: `${text.slice(0, cursor)} ${text.slice(cursor)}`, cursor: cursor + 1 };
}
