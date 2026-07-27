import { RegistryProvider } from "@effect/atom-react";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "TanStack Start + Effect RPC + Drizzle" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <Document>
      {/* One AtomRegistry for the whole app — every AtomRpc query/mutation
          atom resolves against this registry. */}
      <RegistryProvider>
        <Outlet />
      </RegistryProvider>
    </Document>
  );
}

function Document(props: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body
        style={{
          margin: 0,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
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
