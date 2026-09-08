import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
// Tailwind is wired through vite.config.ts (@tailwindcss/vite) — Alchemy
// runs the project's own `vite build`, so the utilities below compile.
import appCss from "../styles/global.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "TanStack Start on Fly" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <Document>
      <Outlet />
    </Document>
  );
}

function Document(props: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="bg-slate-50 p-8 text-slate-900">
        {props.children}
        <Scripts />
      </body>
    </html>
  );
}
