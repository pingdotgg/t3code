import { RenderMarkdownToPdfInputSchema, RenderMarkdownToPdfResultSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DesktopPdfRenderer from "../../pdf/DesktopPdfRenderer.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const renderMarkdownToPdf = makeIpcMethod({
  channel: IpcChannels.RENDER_MARKDOWN_TO_PDF_CHANNEL,
  payload: RenderMarkdownToPdfInputSchema,
  result: RenderMarkdownToPdfResultSchema,
  handler: Effect.fn("desktop.ipc.pdf.renderMarkdownToPdf")(function* (input) {
    const pdfRenderer = yield* DesktopPdfRenderer.DesktopPdfRenderer;
    return yield* pdfRenderer.renderToPdf(input.markdown, input.outputPath).pipe(
      Effect.match({
        onFailure: (error) => ({
          success: false as const,
          filePath: null,
          error: String(error),
        }),
        onSuccess: (res) => ({
          success: true as const,
          filePath: res.pdfPath,
        }),
      }),
    );
  }),
});
