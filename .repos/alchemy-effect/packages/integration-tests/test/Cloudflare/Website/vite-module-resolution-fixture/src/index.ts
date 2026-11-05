// Mirrors `@cloudflare/vite-plugin`'s `playground/module-resolution` (without
// its third-party package routes).
const modules = import.meta.glob("../src/**/*.ts");

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === "/@alias/test") {
      const { test } = await import("@alias/test");
      return test();
    }

    if (pathname === "/virtual-module") {
      // @ts-expect-error virtual module
      const virtualModule = await import("virtual:module");
      return new Response(virtualModule.default);
    }

    if (pathname === "/optimize-deps/exclude") {
      const { virtualExport } = await import(
        // @ts-expect-error virtual module
        "@playground/module-resolution-excludes"
      );

      return new Response(virtualExport);
    }

    const filePath = `${pathname.replace(/^\//, "./")}.ts`;

    if (modules[filePath]) {
      const mod = await modules[filePath]();
      return Response.json((mod as { default: unknown }).default);
    }

    const html = `<!DOCTYPE html>
            <body>
              <h1>Module Resolution App</h1>
              <p>
                This app is an example/test for dependencies module resolution being performed in the Cloudflare environment (inside the workerd runtime)
              </p>
              <hr />
              <h2>Available Routes</h2>
              <ul>
              ${[...Object.keys(modules), "/@alias/test", "optimize-deps/exclude"]
                .map((path) => path.replace(/^\.\//, "/").replace(/\.ts$/, ""))
                .map((route) => `                <li><a href="${route}">${route}</a></li>`)
                .join("\n")}
              </ul>
            </body>`;

    return new Response(html, {
      headers: {
        "content-type": "text/html;charset=UTF-8",
      },
    });
  },
} satisfies ExportedHandler;
