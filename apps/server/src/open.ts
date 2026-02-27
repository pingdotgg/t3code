/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser and workspace
 * paths in a configured editor.
 *
 * @module Open
 */
import { spawn } from "node:child_process";

import { EDITORS, type EditorId } from "@t3tools/contracts";
import { ServiceMap, Schema, Effect, Layer } from "effect";

// ==============================
// Definitions
// ==============================

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

/**
 * OpenShape - Service API for browser and editor launch actions.
 */
export interface OpenShape {
  /**
   * Open a URL target in the default browser.
   */
  readonly openBrowser: (target: string) => Effect.Effect<void, OpenError>;

  /**
   * Open a workspace path in a selected editor integration.
   *
   * Launches the editor as a detached process so server startup is not blocked.
   */
  readonly openInEditor: (input: OpenInEditorInput) => Effect.Effect<void, OpenError>;
}

/**
 * Open - Service tag for browser/editor launch operations.
 */
export class Open extends ServiceMap.Service<Open, OpenShape>()("t3/open") {}

// ==============================
// Implementations
// ==============================

export const resolveEditorLaunch = Effect.fnUntraced(function* (
  input: OpenInEditorInput,
  platform: NodeJS.Platform = process.platform,
): Effect.fn.Return<EditorLaunch, OpenError> {
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new OpenError({ message: `Unknown editor: ${input.editor}` });
  }

  if (editorDef.command) {
    return { command: editorDef.command, args: [input.cwd] };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new OpenError({ message: `Unsupported editor: ${input.editor}` });
  }

  switch (platform) {
    case "darwin":
      return { command: "open", args: [input.cwd] };
    case "win32":
      return { command: "explorer", args: [input.cwd] };
    default:
      return { command: "xdg-open", args: [input.cwd] };
  }
});

export const launchDetached = (launch: EditorLaunch) =>
  Effect.callback<void, OpenError>((resume) => {
    let child;
    try {
      child = spawn(launch.command, [...launch.args], {
        detached: true,
        stdio: "ignore",
      });
    } catch (error) {
      return resume(
        Effect.fail(new OpenError({ message: "failed to spawn detached process", cause: error })),
      );
    }

    const handleSpawn = () => {
      child.unref();
      resume(Effect.void);
    };

    child.once("spawn", handleSpawn);
    child.once("error", (cause) =>
      resume(Effect.fail(new OpenError({ message: "failed to spawn detached process", cause }))),
    );
  });

const make = Effect.gen(function* () {
  const open = yield* Effect.promise(() => import("open"));

  return {
    openBrowser: (target) =>
      Effect.tryPromise({
        try: () => open.default(target),
        catch: (cause) => new OpenError({ message: "Browser auto-open failed", cause }),
      }),
    openInEditor: (input) => Effect.flatMap(resolveEditorLaunch(input), launchDetached),
  } satisfies OpenShape;
});

export const OpenLive = Layer.effect(Open, make);
