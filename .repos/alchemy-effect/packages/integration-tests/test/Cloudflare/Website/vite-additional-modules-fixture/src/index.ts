import subpathHtml from "#html";
import subpathHtmlWithExt from "#modules/html-example.html";
// Mirrors `@cloudflare/vite-plugin`'s `playground/additional-modules`.
import bin from "./modules/bin-example.bin";
import html from "./modules/html-example.html";
import sql from "./modules/sql-example.sql";
import text from "./modules/text-example.txt";
import text2 from "./modules/text__example__2.txt";
import wasm from "./modules/wasm-example.wasm";
import init from "./modules/wasm-example.wasm?init";
import wasmWithModuleParam from "./modules/wasm-example.wasm?module";

interface Instance {
  exports: {
    add(a: number, b: number): number;
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/bin": {
        return Response.json({ byteLength: bin.byteLength });
      }
      case "/html": {
        return new Response(String(html), { headers: { "Content-Type": "text/html" } });
      }
      case "/subpath-html": {
        return new Response(String(subpathHtml), {
          headers: { "Content-Type": "text/html" },
        });
      }
      case "/subpath-html-with-ext": {
        return new Response(String(subpathHtmlWithExt), {
          headers: { "Content-Type": "text/html" },
        });
      }
      case "/text": {
        return new Response(text);
      }
      case "/text2": {
        return new Response(text2);
      }
      case "/sql": {
        return new Response(sql);
      }
      case "/wasm": {
        const instance = (await WebAssembly.instantiate(wasm)) as Instance;
        const result = instance.exports.add(3, 4);

        return Response.json({ result });
      }
      case "/wasm-with-module-param": {
        const instance = (await WebAssembly.instantiate(wasmWithModuleParam)) as Instance;
        const result = instance.exports.add(5, 6);

        return Response.json({ result });
      }
      case "/wasm-with-init-param": {
        const instance = (await init()) as Instance;
        const result = instance.exports.add(7, 8);

        return Response.json({ result });
      }
      default: {
        return new Response(null, { status: 404 });
      }
    }
  },
} satisfies ExportedHandler;
