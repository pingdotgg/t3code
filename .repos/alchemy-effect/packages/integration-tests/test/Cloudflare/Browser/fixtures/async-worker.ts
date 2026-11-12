import puppeteer from "@cloudflare/puppeteer";
import type { AsyncWorkerEnv } from "./stack.ts";

const TARGET_URL = "https://example.com";

export default {
  async fetch(request: Request, env: AsyncWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/title") {
      return new Response("ok");
    }

    const browser = await puppeteer.launch(env.BROWSER as any);
    try {
      const page = await browser.newPage();
      await page.goto(TARGET_URL, { waitUntil: "networkidle0" });
      const title = await page.title();
      return Response.json({ mode: "async", title });
    } finally {
      await browser.close();
    }
  },
};
