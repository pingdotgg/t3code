import {
  start as startViewer,
  stop,
  command,
} from "../../../mobile/src/features/browser/preview-stream.browser";
import {
  previewStreamDocument,
  type PreviewStreamConfiguration,
} from "../../../mobile/src/features/browser/preview-stream-document";

export { stop, command };

/** Keep the native canvas, touch input and styles on the same viewer as RN. */
export function start(configuration: PreviewStreamConfiguration) {
  const template = new DOMParser().parseFromString(previewStreamDocument("null", ""), "text/html");
  for (const style of template.querySelectorAll("style")) document.head.append(style);
  startViewer(configuration);
}
