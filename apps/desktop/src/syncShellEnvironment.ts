import { readEnvironmentFromLoginShell, ShellEnvironmentReader } from "@t3tools/shared/shell";

export function syncShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    readEnvironment?: ShellEnvironmentReader;
  } = {},
): void {
  if ((options.platform ?? process.platform) !== "darwin") return;

  try {
    const shell = env.SHELL ?? "/bin/zsh";
    const shellEnvironment = (options.readEnvironment ?? readEnvironmentFromLoginShell)(shell, [
      "PATH",
      "SSH_AUTH_SOCK",
    ]);

    if (shellEnvironment.PATH) {
      env.PATH = shellEnvironment.PATH;
    }

    if (!env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }
  } catch {
    // Keep inherited environment if shell lookup fails.
  }
}
