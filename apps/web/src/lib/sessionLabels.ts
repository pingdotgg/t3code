export function compactSessionModel(label: string): string {
  const family = /\b(opus|fable|sol|astra)\b/i.exec(label);
  if (!family) return label;
  const version = /\d+(?:[.-]\d+)?/.exec(label)?.[0]?.replace("-", ".");
  return `${family[0][0]!.toUpperCase()}${version ?? ""}`;
}

export function sessionMachineLabel(label: string | null): string {
  const name = label?.trim() ?? "";
  return /^(?:m3|m5|j)$/i.test(name) ? name.toUpperCase() : name;
}
