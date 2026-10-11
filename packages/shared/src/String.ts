export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  // Back off to a grapheme boundary so the cut never splits a surrogate pair,
  // drops a skin tone, variation selector or combining mark, breaks a ZWJ
  // sequence, or separates the two halves of a flag.
  let end = maxLength;
  while (isMidCluster(trimmed, end)) {
    end = codePointStart(trimmed, end);
  }
  return `${trimmed.slice(0, end)}...`;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
const isRegionalIndicator = (code: number | undefined): boolean =>
  code !== undefined && code >= 0x1f1e6 && code <= 0x1f1ff;

// Code points that attach to the one before them: combining marks (which
// include variation selectors and the keycap mark), ZWJ, skin-tone modifiers
// and emoji tag characters. Intl.Segmenter would cover these, but Hermes lacks it.
function attachesToPrevious(code: number | undefined): boolean {
  if (code === undefined) return false;
  return (
    code === 0x200d ||
    (code >= 0x1f3fb && code <= 0x1f3ff) ||
    (code >= 0xe0020 && code <= 0xe007f) ||
    /\p{M}/u.test(String.fromCodePoint(code))
  );
}

// Start index of the code point ending at text[index - 1].
function codePointStart(text: string, index: number): number {
  return index > 1 &&
    isLowSurrogate(text.charCodeAt(index - 1)) &&
    isHighSurrogate(text.charCodeAt(index - 2))
    ? index - 2
    : index - 1;
}

// True when a cut at `index` falls inside a grapheme cluster: between the
// halves of a surrogate pair, before a code point that attaches to the
// previous one, after a ZWJ, or between the two regional indicators of a flag.
function isMidCluster(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) {
    return false;
  }
  if (isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index))) {
    return true;
  }
  if (attachesToPrevious(text.codePointAt(index))) {
    return true;
  }
  const start = codePointStart(text, index);
  const code = text.codePointAt(start);
  if (code === 0x200d) {
    return true;
  }
  if (isRegionalIndicator(code) && isRegionalIndicator(text.codePointAt(index))) {
    // RIs pair from the start of their run: an odd number of RIs before this
    // one means it completes a flag, so the cut after it is safe.
    let count = 0;
    for (let i = start; i > 0;) {
      i = codePointStart(text, i);
      if (!isRegionalIndicator(text.codePointAt(i))) break;
      count += 1;
    }
    return count % 2 === 0;
  }
  return false;
}
