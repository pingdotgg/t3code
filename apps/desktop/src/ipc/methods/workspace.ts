import {
  EnsureStudentWorkspaceInputSchema,
  EnsureStudentWorkspaceResultSchema,
  OpenPathInputSchema,
  OpenPathResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as DesktopWorkspace from "../../workspace/DesktopWorkspace.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const ensureStudentWorkspace = makeIpcMethod({
  channel: IpcChannels.ENSURE_STUDENT_WORKSPACE_CHANNEL,
  payload: EnsureStudentWorkspaceInputSchema,
  result: EnsureStudentWorkspaceResultSchema,
  handler: Effect.fn("desktop.ipc.workspace.ensureStudentWorkspace")(function* (input) {
    const workspace = yield* DesktopWorkspace.DesktopWorkspace;

    // Use studentId as the slug for now (until Students persistence layer is added)
    // TODO: Look up student record to get name/subjects/school for AGENTS.md template
    const slug = input.studentId;

    return yield* workspace.ensureStudentWorkspace({ slug }).pipe(
      Effect.match({
        onFailure: (error) => ({
          success: false as const,
          workspacePath: null,
          error: String(error),
        }),
        onSuccess: (res) => ({
          success: true as const,
          workspacePath: res.folderPath,
        }),
      }),
    );
  }),
});

export const openPath = makeIpcMethod({
  channel: IpcChannels.OPEN_PATH_CHANNEL,
  payload: OpenPathInputSchema,
  result: OpenPathResultSchema,
  handler: Effect.fn("desktop.ipc.workspace.openPath")(function* (input) {
    const shell = yield* ElectronShell.ElectronShell;
    return yield* shell.openPath(input.path).pipe(
      Effect.match({
        onFailure: (error) => ({
          success: false as const,
          error: String(error),
        }),
        onSuccess: (success) => ({
          success,
          ...(success ? {} : { error: "Failed to open path" }),
        }),
      }),
    );
  }),
});
