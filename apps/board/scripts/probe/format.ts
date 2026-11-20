export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The error and its causes, outermost first. */
export function describeError(error: Error): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" <- ");
}

/** The innermost cause, which names why a wrapped engine error happened. */
export const rootCause = (error: Error): string => describeError(error).split(" <- ").at(-1) ?? "";

/** Entity ids run past 100 characters; the last 36 are the unique UUID part. */
export const short = (value: string) => (value.length > 48 ? `…${value.slice(-36)}` : value);

export const clip = (text: string, length = 240) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
};
