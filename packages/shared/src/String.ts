export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  const characters = Array.from(trimmed);
  if (characters.length <= maxLength) {
    return trimmed;
  }

  let end = Math.trunc(maxLength);
  while (end > 0 && /\p{M}/u.test(characters[end] ?? "")) {
    end -= 1;
  }

  return `${characters.slice(0, end).join("").trimEnd()}...`;
}
