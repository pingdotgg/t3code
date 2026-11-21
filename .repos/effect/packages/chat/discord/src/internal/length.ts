/**
 * Discord's limit on `content`, in code points, inclusive.
 *
 * @internal
 */
export const messageLength = 2000

/** The index past the code point at `i`: a surrogate pair is one, a lone surrogate one too. */
const next = (text: string, i: number): number => text.codePointAt(i)! > 0xffff ? i + 2 : i + 1

/**
 * Code points, which is what Discord counts: a recorded probe took 2,000
 * astral emoji (4,000 UTF-16 units) and refused 1,999 letters and a flag.
 *
 * @internal
 */
export const codePoints = (text: string): number => {
  let count = 0
  for (let i = 0; i < text.length; i = next(text, i)) count++
  return count
}

/**
 * Cuts `text` to at most `max` code points.
 *
 * @internal
 */
export const cut = (text: string, max: number): string => {
  for (let i = 0, count = 0; i < text.length; i = next(text, i), count++) {
    if (count === max) return text.slice(0, i)
  }
  return text
}
