import type { ExecutionEnvironmentPlatformOs } from "@t3tools/contracts";

export function claudeCloudSessionId(value: string): string | null {
  let id = value.trim();
  if (id.startsWith("https://")) {
    try {
      const url = new URL(id);
      if (url.origin !== "https://claude.ai" || url.username || url.password) return null;
      id = url.pathname.replace(/^\/code\//, "");
    } catch {
      return null;
    }
  }
  return /^(?:session|cse)_[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

export function claudeCloudCommand(input: {
  binaryPath: string;
  platform: ExecutionEnvironmentPlatformOs;
  message: string;
  session: string;
}): string {
  const message = input.message.trim();
  if (!message || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(message)) {
    throw new Error("Enter a task or message on a single line.");
  }
  if (input.platform !== "darwin" && input.platform !== "linux") {
    throw new Error("Claude Cloud terminal launch is not supported on this platform.");
  }
  if (/[\x00-\x1f\x7f-\x9f]/u.test(input.binaryPath)) {
    throw new Error("The Claude executable path contains terminal control characters.");
  }
  const sessionId = input.session.trim() ? claudeCloudSessionId(input.session) : null;
  if (input.session.trim() && !sessionId)
    throw new Error("Enter a Claude cloud session ID or https://claude.ai/code/ URL.");
  if (
    message.startsWith("-") ||
    (!sessionId && (claudeCloudSessionId(message) || message.startsWith("https://claude.ai/code/")))
  ) {
    throw new Error("Describe a new task, or put the existing session in the session field.");
  }
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const binary = input.binaryPath || "claude";
  const executable = binary.startsWith("~/") ? `~/${quote(binary.slice(2))}` : quote(binary);
  const args = sessionId
    ? ["-p", message, "--cloud", sessionId, "--output-format", "json"]
    : ["--cloud", message];
  const command = `${executable} ${args.map(quote).join(" ")}`;
  // Shells like dash read in canonical mode, where Linux drops input past 4,096 bytes per line.
  if (new TextEncoder().encode(command).length >= 4096) {
    throw new Error("Shorten the task or message to fit on one terminal line (about 4,000 bytes).");
  }
  return command;
}
