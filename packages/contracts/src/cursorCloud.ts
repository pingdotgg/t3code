import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const CURSOR_CLOUD_INSTANCE_ID = ProviderInstanceId.make("cursor-cloud");

const CURSOR_CLOUD_MOUNT = ".t3-cursor-cloud";
const MOUNTED_PATH = /^(?:[A-Za-z]:)?[\\/]\.t3-cursor-cloud[\\/]([^\\/]+)(?:[\\/](.*))?$/;

/**
 * Where a cloud thread's VM workspace appears on its T3 server. The server runs files, Git, and
 * terminals under this path on the VM, so clients use it as the thread's working directory.
 */
export const cursorCloudWorkspacePath = (threadId: string) => `/${CURSOR_CLOUD_MOUNT}/${threadId}`;

/** A thread's worktree for files, terminals, and Git; Cursor Cloud threads work on their VM. */
export const threadWorkspacePath = (thread: {
  readonly id: string;
  readonly worktreePath: string | null;
  readonly modelSelection: { readonly instanceId: string };
}) =>
  thread.modelSelection.instanceId === CURSOR_CLOUD_INSTANCE_ID
    ? cursorCloudWorkspacePath(thread.id)
    : thread.worktreePath;

/** The thread and the path relative to its VM workspace, or null for ordinary host paths. */
export const parseCursorCloudWorkspacePath = (path: string) => {
  const match = MOUNTED_PATH.exec(path);
  if (!match?.[1]) return null;
  return {
    threadId: ThreadId.make(match[1]),
    relativePath: (match[2] ?? "").replaceAll("\\", "/").replace(/\/+$/, ""),
  };
};

export const CursorCloudStatus = Schema.Struct({
  enabled: Schema.Boolean,
  instanceId: Schema.optionalKey(ProviderInstanceId),
});
export const CursorCloudConnectInput = Schema.Struct({ instanceId: ProviderInstanceId });

export const CursorCloudMachineInput = Schema.Struct({ threadId: ThreadId });

/** `pending` threads have not created their cloud agent yet; it starts with the first message. */
export const CursorCloudMachineState = Schema.Literals([
  "pending",
  "asleep",
  "starting",
  "running",
  "expired",
  "error",
]);
export type CursorCloudMachineState = typeof CursorCloudMachineState.Type;

export const CursorCloudMachineStatus = Schema.Struct({
  state: CursorCloudMachineState,
  agentStatus: Schema.optionalKey(
    Schema.Literals(["creating", "running", "finished", "error", "expired"]),
  ),
  agentUrl: Schema.optionalKey(Schema.String),
});
export type CursorCloudMachineStatus = typeof CursorCloudMachineStatus.Type;

export class CursorCloudError extends Schema.TaggedError<CursorCloudError>()("CursorCloudError", {
  reason: Schema.Literals([
    "disabled",
    "pending",
    "asleep",
    "credentials",
    "authentication",
    "request",
    "response",
  ]),
  status: Schema.optionalKey(Schema.Number),
}) {
  override get message(): string {
    switch (this.reason) {
      case "disabled":
        return "Connect Cursor Cloud in Settings > Connections first.";
      case "pending":
        return "This thread's Cursor Cloud machine starts with its first message.";
      case "asleep":
        return "This thread's Cursor Cloud machine is asleep. Wake it to browse files and Git.";
      case "authentication":
        return "Sign in to the selected Cursor account in Settings > Providers, then reconnect Cursor Cloud.";
      case "credentials":
        return "Could not save or read the Cursor Cloud connection.";
      case "response":
        return "Cursor Cloud returned an unexpected response.";
      case "request":
        return this.status === undefined
          ? "Could not reach Cursor Cloud. Try connecting again."
          : `Cursor Cloud request failed (HTTP ${this.status}).`;
    }
  }
}
