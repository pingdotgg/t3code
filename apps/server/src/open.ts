import { spawn } from "node:child_process";

import { EDITORS, type EditorId } from "@t3tools/contracts";
import { ServiceMap, Schema, Effect, Layer } from "effect";

export class OpenError extends Schema.TaggedErrorClass<OpenError>()("OpenError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface OpenInEditorInput {
  readonly cwd: string;
  readonly editor: EditorId;
}

interface EditorLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface OpenShape {
  readonly openBrowser: (target: string) => Effect.Effect<void, OpenError>;
  readonly openInEditor: (input: OpenInEditorInput) => Effect.Effect<void, OpenError>;
}

export class Open extends ServiceMap.Service<Open, OpenShape>()("server/Open") {}

export function resolveEditorLaunch(
  input: OpenInEditorInput,
  platform: NodeJS.Platform = process.platform,
): EditorLaunch {
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    throw new OpenError({ message: `Unknown editor: ${input.editor}` });
  }

  if (editorDef.command) {
    return { command: editorDef.command, args: [input.cwd] };
  }

  if (editorDef.id !== "file-manager") {
    throw new OpenError({ message: `Unsupported editor: ${input.editor}` });
  }

  switch (platform) {
    case "darwin":
      return { command: "open", args: [input.cwd] };
    case "win32":
      return { command: "explorer", args: [input.cwd] };
    default:
      return { command: "xdg-open", args: [input.cwd] };
  }
}

export function launchDetached(command: string, args: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      detached: true,
      stdio: "ignore",
    });

    const handleSpawn = () => {
      child.unref();
      resolve();
    };

    child.once("spawn", handleSpawn);
    child.once("error", (error) => reject(error));
  });
}

const make = Effect.gen(function* () {
  const open = yield* Effect.promise(() => import("open"));

  return {
    openBrowser: (target) =>
      Effect.tryPromise({
        try: () => open.default(target),
        catch: (cause) => new OpenError({ message: "Browser auto-open failed", cause }),
      }),
    openInEditor: (input) =>
      Effect.tryPromise({
        try: () => {
          const launch = resolveEditorLaunch(input);
          return launchDetached(launch.command, launch.args);
        },
        catch: (cause) =>
          cause instanceof OpenError
            ? cause
            : new OpenError({ message: "Failed to open editor", cause }),
      }),
  } satisfies OpenShape;
});

export const OpenLive = Layer.effect(Open, make);
