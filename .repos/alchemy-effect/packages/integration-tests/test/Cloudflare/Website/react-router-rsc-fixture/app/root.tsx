/** @jsxImportSource react */
import { Link, Outlet } from "react-router";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>React Router Vite</title>
      </head>
      <body>
        <header>
          <nav aria-label="Fixture routes">
            <Link to="/">Home</Link>
            {" | "}
            <Link to="/about">About</Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}

export default function Component() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: { error?: unknown }) {
  return (
    <main>
      <h1>React Router RSC fixture error</h1>
      <pre>{error instanceof Error ? error.message : String(error)}</pre>
    </main>
  );
}
