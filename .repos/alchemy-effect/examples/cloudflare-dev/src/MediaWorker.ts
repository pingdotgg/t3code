/**
 * Media & messaging worker — Browser Rendering, Images, Stream, Secrets
 * Store, and outbound Email, one route per feature. Under `alchemy dev`
 * every binding is served by a local simulator (Chrome for BROWSER, sharp
 * for IMAGES, an on-disk store for STREAM and email) except `IMAGES_REMOTE`,
 * which opted into `dev: { remote: true }` and proxies to the real Images
 * service. The inbound `email()` handler lives on {@link InboxWorker} — see
 * the note there.
 */
import puppeteer from "@cloudflare/puppeteer";
import type * as cf from "@cloudflare/workers-types";
import { EmailMessage } from "cloudflare:email";

const PAGE_HTML =
  "<html><head><title>Cloudflare Dev</title></head>" +
  "<body><h1>Hello from the local browser</h1></body></html>";

interface SendEmailLike {
  send(message: unknown): Promise<{ messageId: string }>;
}

interface Env {
  BROWSER: unknown;
  IMAGES: cf.ImagesBinding;
  IMAGES_REMOTE: cf.ImagesBinding;
  STREAM: cf.StreamBinding;
  EMAIL: SendEmailLike;
  API_KEY: { get(): Promise<string> };
}

const imagesInfo = async (images: cf.ImagesBinding, request: Request) => {
  const info = await images.info(
    request.body as unknown as cf.ReadableStream<Uint8Array>,
  );
  return Response.json(info);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/secret": {
          // Secrets Store secret via the `secrets_store_secret` binding —
          // the exact seeded value round-trips.
          return Response.json({ value: await env.API_KEY.get() });
        }
        case "/browser/title": {
          // Browser Rendering the way real users drive it — through
          // @cloudflare/puppeteer. Locally this launches a real Chrome.
          const browser = await puppeteer.launch(env.BROWSER as any);
          try {
            const page = await browser.newPage();
            await page.setContent(PAGE_HTML);
            const title = await page.title();
            const heading = await page.$eval("h1", (el) => el.textContent);
            return Response.json({ title, heading });
          } finally {
            await browser.close();
          }
        }
        case "/images/info":
          return imagesInfo(env.IMAGES, request);
        case "/images/info-remote":
          // Same call, but through the `Alchemy.remote()`-piped binding —
          // served by the REAL Images service even during `alchemy dev`.
          return imagesInfo(env.IMAGES_REMOTE, request);
        case "/images/transform": {
          const width = Number(url.searchParams.get("width") ?? "4");
          const output = await env.IMAGES.input(
            request.body as unknown as cf.ReadableStream<Uint8Array>,
          )
            .transform({ width })
            .output({ format: "image/png" });
          return output.response() as unknown as Response;
        }
        case "/stream/upload": {
          // The local simulator (like Miniflare's stream plugin) accepts a
          // ReadableStream of the video bytes in place of a URL; the
          // published types only declare the URL overload.
          const upload = env.STREAM.upload as unknown as (
            input: ReadableStream | string,
            params?: cf.StreamUrlUploadParams,
          ) => Promise<cf.StreamVideo>;
          const video = await upload(
            request.body as unknown as ReadableStream,
            {
              meta: { title: "cloudflare-dev-example" },
              creator: "alchemy",
            },
          );
          return Response.json(video);
        }
        case "/stream/details": {
          const video = await env.STREAM.video(
            url.searchParams.get("id")!,
          ).details();
          return Response.json(video);
        }
        case "/stream/delete": {
          await env.STREAM.video(url.searchParams.get("id")!).delete();
          return Response.json({ deleted: true });
        }
        case "/email/send": {
          // send_email binding: locally the message is persisted as an
          // `.eml` under `.alchemy/local/email` instead of being delivered.
          const marker = url.searchParams.get("marker") ?? "no-marker";
          const raw = [
            "From: sender <sender@example.com>",
            "To: recipient <allowed@example.com>",
            `Message-ID: <${marker}@example.com>`,
            "MIME-Version: 1.0",
            "Content-Type: text/plain",
            "",
            `marker:${marker}`,
          ].join("\r\n");
          const result = await env.EMAIL.send(
            new EmailMessage("sender@example.com", "allowed@example.com", raw),
          );
          return Response.json({ ok: true, messageId: result.messageId });
        }
        default:
          return new Response("ok");
      }
    } catch (e) {
      return Response.json(
        { ok: false, message: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  },
};
