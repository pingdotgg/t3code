import type { ReactNode } from "react";
import { Link } from "waku";

// Global stylesheet — Tailwind CSS v4, compiled by the @tailwindcss/vite
// plugin registered in waku.config.ts.
import "../styles.css";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl p-8">
      <nav className="mb-6 flex gap-4 font-medium underline">
        <Link to="/">Home</Link> <Link to="/about">About</Link>
      </nav>
      {children}
    </div>
  );
}

export const getConfig = async () => ({ render: "static" }) as const;
