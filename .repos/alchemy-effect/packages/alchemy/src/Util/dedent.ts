/**
 * Tagged template literal for removing indentation from a block of text.
 *
 * If the first line is empty, it will be ignored.
 */
export function dedent(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string;
export function dedent(text: string): string;
export function dedent(
  stringsOrText: TemplateStringsArray | string,
  ...values: unknown[]
): string {
  const raw =
    typeof stringsOrText === "string"
      ? stringsOrText
      : String.raw({ raw: stringsOrText }, ...values);

  let lines = raw.split("\n");

  while (lines.length > 0 && lines[0].trim() === "") {
    lines = lines.slice(1);
  }

  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines = lines.slice(0, lines.length - 1);
  }

  if (lines.length === 0) {
    return "";
  }

  let minIndentLength = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim() !== "") {
      const indent = line.match(/^[ \t]*/)?.[0];
      if (indent != null && indent.length < minIndentLength) {
        minIndentLength = indent.length;
      }
    }
  }

  if (minIndentLength === Number.POSITIVE_INFINITY) {
    return lines.join("\n");
  }

  lines = lines.map((line) => {
    if (line.trim() === "") {
      return line;
    }
    return line.startsWith(" ".repeat(minIndentLength)) ||
      line.startsWith("\t".repeat(minIndentLength))
      ? line.substring(minIndentLength)
      : line;
  });

  return lines.join("\n");
}
