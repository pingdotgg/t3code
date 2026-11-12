// Mirrors `@cloudflare/vite-plugin`'s `playground/node-env`: Vite replaces
// `process.env.NODE_ENV` in the Worker ("development" in dev, "production"
// in a build, where React's development code is tree-shaken away).
import React from "react";
import { renderToString } from "react-dom/server";

declare const process: { env: { NODE_ENV: string } };

export default {
  async fetch() {
    const txt = renderToString(
      React.createElement("div", null, [
        React.createElement("h1", { key: "h1" }, `Server Side React`),
        React.createElement(
          "p",
          { key: "p" },
          `The value of process.env.NODE_ENV is "${process.env.NODE_ENV}"`,
        ),
      ]),
    );

    return new Response(
      `<!DOCTYPE html><html><head><title>React Server Render</title></head><body><div id="app">${txt}</div></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  },
};
