import subpathHtmlWithExt from "#modules/html-example.html";
import bin from "./modules/bin-example.bin";
import html from "./modules/html-example.html";
import sql from "./modules/sql-example.sql";
import text from "./modules/text-example.txt";
import text2 from "./modules/text__example__2.txt";
import wasm from "./modules/wasm-example.wasm";
import init from "./modules/wasm-example.wasm?init";
import wasmWithModuleParam from "./modules/wasm-example.wasm?module";

// Removed because this seems to be a Vite-specific feature, rather than a Rolldown feature.
// TODO: Find out if this works with Vite.
// import subpathHtml from "#html";

interface Instance {
  exports: {
    add(a: number, b: number): number;
  };
}

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/bin":
        return Response.json({ byteLength: bin.byteLength });
      case "/html":
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      // case "/subpath-html":
      //   return new Response(subpathHtml, {
      //     headers: { "Content-Type": "text/html" },
      //   });
      case "/subpath-html-with-ext":
        return new Response(subpathHtmlWithExt, {
          headers: { "Content-Type": "text/html" },
        });
      case "/text":
        return new Response(text);
      case "/text2":
        return new Response(text2);
      case "/sql":
        return new Response(sql);
      case "/wasm": {
        const instance = (await WebAssembly.instantiate(wasm)) as Instance;
        return Response.json({ result: instance.exports.add(3, 4) });
      }
      case "/wasm-with-module-param": {
        const instance = (await WebAssembly.instantiate(wasmWithModuleParam)) as Instance;
        return Response.json({ result: instance.exports.add(5, 6) });
      }
      case "/wasm-with-init-param": {
        const instance = (await init()) as Instance;
        return Response.json({ result: instance.exports.add(7, 8) });
      }
      default:
        return new Response(null, { status: 404 });
    }
  },
} satisfies ExportedHandler;
