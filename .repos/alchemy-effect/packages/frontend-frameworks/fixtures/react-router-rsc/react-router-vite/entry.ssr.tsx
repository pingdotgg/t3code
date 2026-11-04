import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";
import { renderToReadableStream as renderHTMLToReadableStream } from "react-dom/server.edge";
import {
  unstable_routeRSCServerRequest as routeRSCServerRequest,
  unstable_RSCStaticRouter as RSCStaticRouter,
} from "react-router";

export default async function handler(
  request: Request,
  serverResponse: Response,
): Promise<Response> {
  const bootstrapScriptContent = await import.meta.viteRsc.loadBootstrapScriptContent("index");

  return await routeRSCServerRequest({
    request,
    serverResponse,
    createFromReadableStream,
    async renderHTML(getPayload, options) {
      const payload = getPayload();

      return await renderHTMLToReadableStream(<RSCStaticRouter getPayload={getPayload} />, {
        ...options,
        bootstrapScriptContent,
        signal: request.signal,
        formState: await payload.formState,
      });
    },
  });
}
