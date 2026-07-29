export function terminalLabelsById(
  terminalIds: readonly string[],
): Readonly<Record<string, string>> {
  const normalizedIds = [...new Set(terminalIds.map((id) => id.trim()).filter(Boolean))];
  return Object.fromEntries(
    normalizedIds.map((terminalId, index) => [terminalId, `Terminal ${index + 1}`]),
  );
}
