const FIELD_LINE = /^(\*{1,2}|_{1,2})?[\p{L}][\p{L}\p{N} /_-]{0,31}(?:\1:|:\1)[ \t]+\S/u;

export const FIELD_LINE_BREAK = /\r\n?|\n/;

export function isAssistantFieldLine(line: string): boolean {
  return FIELD_LINE.test(line.trimStart());
}

export function isAssistantFieldBlock(source: string): boolean {
  const lines = source.split(FIELD_LINE_BREAK);
  return lines.length > 1 && lines.every(isAssistantFieldLine);
}
