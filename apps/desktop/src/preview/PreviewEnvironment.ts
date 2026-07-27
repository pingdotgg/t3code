import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/**
 * Filesystem locations the preview runtime needs. Kept separate from the
 * desktop bootstrap so the preview slice can be started from the existing
 * Electron main process without pulling in an app-wide environment service.
 */
export class PreviewEnvironment extends Context.Service<
  PreviewEnvironment,
  {
    /** Directory that screenshots and screen recordings are written to. */
    readonly browserArtifactsDir: string;
  }
>()("@t3tools/desktop/preview/PreviewEnvironment") {}

export const layer = (browserArtifactsDir: string) =>
  Layer.succeed(PreviewEnvironment, PreviewEnvironment.of({ browserArtifactsDir }));
