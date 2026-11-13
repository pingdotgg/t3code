/**
 * Preview artifact reveal and clipboard helpers.
 */
import {
  BrowserWindow,
  ClipboardItem,
  app,
  type Session,
  clipboard,
  nativeImage,
  shell,
  webContents,
} from "electron";
import * as Effect from "effect/Effect";
import {
  PreviewArtifactImageLoadError,
} from "../errors.ts";
import type { SessionOps } from "./session.ts";
import type { State } from "./state.ts";

export const makeArtifactsOps = (deps: State & SessionOps) => {
  const {
    attempt,
    attemptPromise,
  } = deps;
  const m = deps.mutable;
  const revealArtifact = Effect.fn("PreviewManager.revealArtifact")(function* (
    artifactPath: string,
  ) {
    const resolvedPath = yield* deps.resolveArtifactPath(artifactPath);
    yield* attempt({ operation: "revealArtifact", artifactPath: resolvedPath }, () =>
      shell.showItemInFolder(resolvedPath),
    );
  });

  const copyArtifactToClipboard = Effect.fn("PreviewManager.copyArtifactToClipboard")(function* (
    artifactPath: string,
  ) {
    const resolvedPath = yield* deps.resolveArtifactPath(artifactPath);
    const image = yield* attempt(
      { operation: "copyArtifactToClipboard.load", artifactPath: resolvedPath },
      () => nativeImage.createFromPath(resolvedPath),
    );
    if (image.isEmpty()) {
      return yield* new PreviewArtifactImageLoadError({ artifactPath: resolvedPath });
    }
    yield* attemptPromise(
      { operation: "copyArtifactToClipboard.write", artifactPath: resolvedPath },
      () =>
        clipboard.write([
          new ClipboardItem({
            "image/png": new Blob([Uint8Array.from(image.toPNG())], { type: "image/png" }),
          }),
        ]),
    );
  });

  return { revealArtifact, copyArtifactToClipboard };
};

export type ArtifactsOps = ReturnType<typeof makeArtifactsOps>;
