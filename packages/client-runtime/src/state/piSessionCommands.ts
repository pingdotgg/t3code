import {
  providerSlashCommandArgumentError,
  type ProviderSessionCommandInput,
} from "@t3tools/contracts";

/** Recognized utilities never fall through to an agent prompt when arguments are invalid. */
export function parsePiSessionCommand(
  text: string,
): Omit<ProviderSessionCommandInput, "threadId"> | { readonly error: string } | null {
  const trimmed = text.trim();
  const noArgs = /^\/(copy|share)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (noArgs) {
    const command = noArgs[1] === "copy" ? "copy" : "share";
    const error = providerSlashCommandArgumentError(
      { name: command, argumentMode: "none" },
      noArgs[2] ?? "",
    );
    return error ? { error } : { command };
  }
  const match = /^\/export(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  if (/[\r\n]/.test(trimmed)) return { error: "/export accepts a path on a single line." };
  const outputPath = match[1]?.trim();
  return { command: "export", ...(outputPath ? { outputPath } : {}) };
}
