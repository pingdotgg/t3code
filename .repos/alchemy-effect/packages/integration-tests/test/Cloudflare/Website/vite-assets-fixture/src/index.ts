/// <reference types="vite/client" />
import vitePackageJson from "vite/package.json?raw";
import vitePackageJsonUrl from "vite/package.json?url";
// Mirrors `@cloudflare/vite-plugin`'s `playground/assets/src/index.ts`, plus
// the additional-module (`playground/build-output`), dependency-asset
// (`playground/deps-assets-importing`) and `?no-inline`
// (`playground/spa-with-api`) cases.
import additionalModule from "./additional-module.txt";
import importedImage from "./imported-image.svg";
import importedText from "./imported-text.txt?url";
import inlineImage from "./inline-image.svg?inline";
import noInlineText from "./no-inline-text.txt?no-inline";
// Importing CSS must not break the Worker build.
import "./index.css";

interface Env {
  ASSETS?: Fetcher;
}

class ElementHandler {
  element(element: Element) {
    element.setInnerContent("Modified content");
  }
}

const withHeader = (response: Response, value: string) => {
  const modified = new Response(response.body, response);
  modified.headers.append("additional-header", value);
  return modified;
};

export default {
  async fetch(request: Request, env: Env) {
    const { origin, pathname } = new URL(request.url);
    if (pathname === "/__assets") {
      return Response.json({ assets: env.ASSETS !== undefined });
    }
    if (pathname === "/additional-module") {
      return new Response(additionalModule);
    }
    if (pathname === "/dependency-asset-raw") {
      const json = JSON.parse(vitePackageJson) as { name: string };
      return new Response(`dependency:${json.name} url:${vitePackageJsonUrl}`);
    }
    if (!env.ASSETS) return new Response("no ASSETS binding", { status: 500 });
    switch (pathname) {
      case "/public-directory-asset":
        return withHeader(
          await env.ASSETS.fetch(new URL("/public-image.svg", origin)),
          "public-directory-asset",
        );
      case "/imported-asset":
        return withHeader(await env.ASSETS.fetch(new URL(importedImage, origin)), "imported-asset");
      case "/imported-asset-url-suffix": {
        const response = await env.ASSETS.fetch(new URL(importedText, origin));
        return new Response(`The text content is "${await response.text()}"`);
      }
      case "/no-inline-asset": {
        const response = await env.ASSETS.fetch(new URL(noInlineText, origin));
        return new Response(`Modified: ${await response.text()}`);
      }
      case "/inline-asset":
        return withHeader(await env.ASSETS.fetch(new URL(inlineImage, origin)), "inline-asset");
      case "/dependency-asset": {
        const response = await env.ASSETS.fetch(new URL(vitePackageJsonUrl, origin));
        return new Response(await response.text());
      }
      case "/transformed-html-asset":
        return new HTMLRewriter()
          .on("h1", new ElementHandler())
          .transform(await env.ASSETS.fetch(new URL("/html-page", origin)));
      default:
        return new Response("vite-assets-worker");
    }
  },
};
