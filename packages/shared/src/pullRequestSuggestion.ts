/** An empty suggestion deletes its line range; null means no unambiguous suggestion. */
export function pullRequestSuggestion(body: string): string | null {
  const suggestions = [...body.matchAll(/^```suggestion\r?\n([\s\S]*?)^```[ \t]*$/gm)];
  return suggestions.length === 1 ? suggestions[0]![1]! : null;
}
