/** @jsxImportSource react */
import { Outlet } from "react-router";
import "./app.css";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>React Router on Cloudflare</title>
      </head>
      <body className="bg-slate-50 p-8 text-slate-900">{children}</body>
    </html>
  );
}

export default function Component() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: { error?: unknown }) {
  return (
    <main>
      <h1>Application error</h1>
      <pre>{error instanceof Error ? error.message : String(error)}</pre>
    </main>
  );
}
