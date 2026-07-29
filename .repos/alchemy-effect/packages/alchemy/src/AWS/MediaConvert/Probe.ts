import type * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `mediaconvert:Probe` — analyze an input media file in
 * S3 (or over HTTPS) and get back its container, codecs, frame rate,
 * resolution, track layout, and captions, to drive transcoding decisions at
 * runtime.
 *
 * The binding takes no arguments and grants `mediaconvert:Probe` on `*`.
 * Note the probing itself reads the file with the *caller's* credentials —
 * the Function also needs S3 read access to the probed object (bind an
 * `AWS.S3.GetObject` capability on the bucket).
 * Provide the implementation with `Effect.provide(AWS.MediaConvert.ProbeHttp)`.
 *
 * @binding
 * @section Inspecting Inputs
 * @example Probe an Uploaded File
 * ```typescript
 * // init
 * const probe = yield* AWS.MediaConvert.Probe();
 *
 * // runtime
 * const { ProbeResults } = yield* probe({
 *   InputFiles: [{ FileUrl: `s3://${bucket}/${key}` }],
 * });
 * const video = ProbeResults?.[0]?.TrackMappings;
 * ```
 */
export interface Probe extends Binding.Service<
  Probe,
  "AWS.MediaConvert.Probe",
  () => Effect.Effect<
    (
      request: mediaconvert.ProbeRequest,
    ) => Effect.Effect<mediaconvert.ProbeResponse, mediaconvert.ProbeError>
  >
> {}
export const Probe = Binding.Service<Probe>("AWS.MediaConvert.Probe");
