import { PreviewCaptureFailure } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeCaptureFailure = Schema.decodeUnknownOption(PreviewCaptureFailure);
/** Decode in the renderer: contextBridge strips custom properties from rejected Errors. */
export function unwrapPreviewCaptureResult<A>(result: A | PreviewCaptureFailure): A {
  const failure = decodeCaptureFailure(result);
  if (Option.isSome(failure)) throw failure.value;
  return result as A;
}
