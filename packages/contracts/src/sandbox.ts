import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A Docker sandbox belongs to one worktree. The server runs that worktree's
 * agents, terminals, and setup script inside the sandbox's container, so each
 * sandbox has its own ports, services, and files outside the worktree. Clients
 * match a thread to its sandbox by the thread's worktree path.
 */
export const SandboxStatus = Schema.Literals(["starting", "running", "stopped", "error"]);
export type SandboxStatus = typeof SandboxStatus.Type;

const PortNumber = Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThan(65536));

/** A port an app listens on inside the sandbox, forwarded to the server host's loopback. */
export const SandboxPort = Schema.Struct({
  containerPort: PortNumber,
  hostPort: PortNumber,
});
export type SandboxPort = typeof SandboxPort.Type;

export const SandboxSummary = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  containerName: TrimmedNonEmptyString,
  image: TrimmedNonEmptyString,
  status: SandboxStatus,
  ports: Schema.Array(SandboxPort),
  /** Human readable reason when status is error. */
  error: Schema.NullOr(Schema.String),
});
export type SandboxSummary = typeof SandboxSummary.Type;

/** The full sandbox list. Sent first, then after every change. */
export const SandboxListStreamEvent = Schema.Struct({
  sandboxes: Schema.Array(SandboxSummary),
});
export type SandboxListStreamEvent = typeof SandboxListStreamEvent.Type;

export const SandboxWorktreeInput = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
});
export type SandboxWorktreeInput = typeof SandboxWorktreeInput.Type;

export class SandboxRequestError extends Schema.TaggedError<SandboxRequestError>()(
  "SandboxRequestError",
  {
    operation: Schema.Literals(["stop", "remove"]),
    worktreePath: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the sandbox for ${this.worktreePath}: ${this.detail}`;
  }
}
