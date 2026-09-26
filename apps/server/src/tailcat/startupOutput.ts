import type { TailcatConnectionCodeResult, TailcatRemoteAccessState } from "@t3tools/contracts";

/**
 * Terminal output for `t3 serve --tailcat`: the connection code a client pastes
 * into Add Environment. The code embeds a single-use pairing credential, so it
 * is handled exactly like the pairing URL.
 */
/** The code and its handling instructions, shared by every terminal entry point. */
export function formatTailcatConnectionCodeLines(
  issued: TailcatConnectionCodeResult,
): ReadonlyArray<string> {
  return [
    `Connection code (expires ${issued.expiresAt}, single use):`,
    issued.code,
    "",
    "Paste the code in the T3 Code desktop app under Add Environment → Tailcat.",
    "This code embeds a one-time pairing credential. Share it only with the device you are pairing.",
  ];
}

export function formatTailcatHeadlessOutput(
  state: TailcatRemoteAccessState,
  issued: TailcatConnectionCodeResult,
): string {
  const path =
    state.runtime === null
      ? "unknown"
      : `${state.runtime.source} ${state.runtime.version} (${state.runtime.executablePath})`;
  return [
    "",
    "Tailcat remote access is ready.",
    `Tailcat address: ${state.address ?? "unknown"}`,
    `Tailcat runtime: ${path}`,
    ...formatTailcatConnectionCodeLines(issued),
    "Trusted devices stay connected after the code expires; issue a new code per device.",
    "",
  ].join("\n");
}
