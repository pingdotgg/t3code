export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  const characters = Array.from(trimmed);
  if (characters.length <= maxLength) {
    return trimmed;
  }

  return `${characters.slice(0, maxLength).join("")}...`;
}
