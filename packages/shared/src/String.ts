export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  // Back off to a grapheme boundary so the cut never splits a surrogate
  // pair, a ZWJ sequence, or a flag pair in half.
  let end = maxLength;
  while (isMidCluster(trimmed, end)) {
    end = codePointStart(trimmed, end);
  }
  return `${trimmed.slice(0, end)}...`;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
const isRegionalIndicator = (code: number): boolean => code >= 0x1f1e6 && code <= 0x1f1ff;

// Start index of the code point ending at text[index - 1].
function codePointStart(text: string, index: number): number {
  return index > 1 && isLowSurrogate(text.charCodeAt(index - 1)) && isHighSurrogate(text.charCodeAt(index - 2))
    ? index - 2
    : index - 1;
}

// True when a cut at `index` falls inside a grapheme cluster: between the
// halves of a surrogate pair, after a ZWJ whose partner is cut off, or
// between the two regional indicators of a flag.
function isMidCluster(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) {
    return false;
  }
  if (isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index))) {
    return true;
  }
  const start = codePointStart(text, index);
  const code = text.codePointAt(start);
  if (code === 0x200d) {
    return true;
  }
  if (isRegionalIndicator(code)) {
    // RIs pair from the start of their run: an odd number of RIs before this
    // one means it completes a flag, so the cut after it is safe.
    let count = 0;
    for (let i = start; i > 0; ) {
      i = codePointStart(text, i);
      if (!isRegionalIndicator(text.codePointAt(i))) break;
      count += 1;
    }
    return count % 2 === 0;
  }
  return false;
}
