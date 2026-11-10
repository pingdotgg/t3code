/** A fenced code block for `code`, with a backtick fence longer than any backtick run inside it. */
export function fencedCodeMarkdown(code: string, language: string): string {
  let longestRun = 0;
  for (const [run] of code.matchAll(/`+/g)) longestRun = Math.max(longestRun, run.length);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}
