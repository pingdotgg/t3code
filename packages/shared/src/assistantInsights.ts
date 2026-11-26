export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return /^★ Insight(?:\s|─)|(?<![^\r\n])`★ Insight[ \t]+─{3,}`[ \t]*(?![^\r\n])/mu.test(text);
}
