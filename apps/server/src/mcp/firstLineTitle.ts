/** Titles in the sidebar and task list are one line. */
export function firstLineTitle(value: string | undefined): string | undefined {
  const line = value
    ?.trim()
    .split(/[\r\n\u2028\u2029]/, 1)[0]
    ?.trim();
  return line || undefined;
}
