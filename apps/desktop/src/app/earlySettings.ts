export function parseEarlySettings(raw: string): Record<string, unknown> {
  const stripped = raw
    .replace(
      /("(?:[^"\\]|\\.)*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
      (match, literal: string | undefined) => (literal ? match : " "),
    )
    .replace(
      /("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g,
      (match, literal: string | undefined, bracket: string | undefined) =>
        literal ? match : (bracket ?? ""),
    );
  const value: unknown = JSON.parse(stripped);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a settings object");
  return value as Record<string, unknown>;
}

export function earlyDesktopSettingsPath(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly joinPath: (first: string, ...segments: string[]) => string;
}): string {
  const t3Home = input.env.T3CODE_HOME?.trim();
  return input.joinPath(
    t3Home || input.joinPath(input.homeDirectory, ".t3"),
    !t3Home && input.env.VITE_DEV_SERVER_URL?.trim() ? "dev" : "userdata",
    "desktop-settings.json",
  );
}
