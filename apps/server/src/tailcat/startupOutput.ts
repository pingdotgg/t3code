import type { TailcatConnectionCodeResult, TailcatRemoteAccessState } from "@t3tools/contracts";

import { renderTerminalQrCode } from "../startupAccess.ts";

/**
 * Terminal output for `t3 serve --tailcat`: the connection code a client pastes
 * into Add Environment, plus a QR for the mobile app. The code embeds a
 * single-use pairing credential, so it is shown exactly like the pairing URL.
 */
export function formatTailcatHeadlessOutput(
  state: TailcatRemoteAccessState,
  issued: TailcatConnectionCodeResult,
): string {
  const path =
    state.runtime === null
      ? "unknown"
      : `${state.runtime.source} ${state.runtime.version ?? "?"} (${state.runtime.executablePath})`;
  return [
    "",
    "Tailcat remote access is ready.",
    `Tailcat address: ${state.address ?? "unknown"}`,
    `Tailcat runtime: ${path}`,
    `Connection code (expires ${issued.expiresAt}, single use):`,
    issued.code,
    "",
    renderTerminalQrCode(issued.code),
    "",
    "Paste the code in T3 Code under Add Environment → Tailcat, or scan it with the mobile app.",
    "Trusted devices stay connected after the code expires; issue a new code per device.",
    "",
  ].join("\n");
}
