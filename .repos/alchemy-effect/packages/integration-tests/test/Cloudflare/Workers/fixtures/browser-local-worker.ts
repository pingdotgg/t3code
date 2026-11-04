// Async (non-Effect) Worker that drives a Browser Rendering binding the way
// real users do — through `@cloudflare/puppeteer` (acquire a session, open a
// page, inspect it). Used by Browser.local.test.ts both against the local
// Chrome-backed simulator and (piped through `Alchemy.remote()`) against the real
// Browser Rendering service via the remote-bindings proxy.
import puppeteer from "@cloudflare/puppeteer";

const PAGE_HTML =
  "<html><head><title>Local Browser Test</title></head>" +
  "<body><h1>Hello from the local browser</h1></body></html>";

type Env = Record<string, unknown>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/title") {
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
      if (url.pathname === "/screenshot") {
        const browser = await puppeteer.launch(env.BROWSER as any);
        try {
          const page = await browser.newPage();
          await page.setContent(PAGE_HTML);
          const screenshot = await page.screenshot();
          return new Response(screenshot as any, {
            headers: { "content-type": "image/png" },
          });
        } finally {
          await browser.close();
        }
      }
      return new Response("ok");
    } catch (e: any) {
      return new Response(`browser fixture error: ${e?.stack ?? String(e)}`, {
        status: 500,
      });
    }
  },
};
