/**
 * Claude Code → Codex bridge sign-in state (fork feature f5).
 *
 * Device login is a one-shot stream command. Mounting starts it and unmounting
 * cancels it; reconnecting must not silently begin a fresh authorization.
 */
import { WS_METHODS, type ClaudeCodexBridgeSignInEvent } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { runStream } from "../rpc/client.ts";
import { createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

export interface ClaudeCodexBridgeSignInRequest {
  readonly attempt: number;
}

export type ClaudeCodexBridgeSignInStatus = ClaudeCodexBridgeSignInEvent | undefined;

export function createClaudeCodexRoutingEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    signInEvents: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:claude-codex-routing:sign-in",
      idleTtlMs: 0,
      subscribe: (input: ClaudeCodexBridgeSignInRequest) =>
        runStream(WS_METHODS.claudeCodexBridgeStartSignIn, input),
    }),
  };
}
