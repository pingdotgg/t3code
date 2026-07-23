/// <reference types="vite/client" />
import { HeadContent, Scripts, createRootRoute } from "@tanstack/solid-router";
import type * as Solid from "solid-js";
import { HydrationScript } from "solid-js/web";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      { title: "TanStack Start Solid on Cloudflare" },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument(props: Readonly<{ children: Solid.JSX.Element }>) {
  return (
    <html lang="en">
      <head>
        <HydrationScript />
        <HeadContent />
      </head>
      <body
        style={{
          margin: 0,
          "font-family": "ui-sans-serif, system-ui, sans-serif",
          background: "#f8fafc",
          color: "#0f172a",
        }}
      >
        {props.children}
        <Scripts />
      </body>
    </html>
  );
}
