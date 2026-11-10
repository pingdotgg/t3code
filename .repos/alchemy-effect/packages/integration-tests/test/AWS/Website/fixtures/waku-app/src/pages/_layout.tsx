/** @jsxImportSource react */
import type { ReactNode } from "react";
import { Link } from "waku";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div>
      <nav>
        <Link to="/">Home</Link> <Link to="/about">About</Link>
      </nav>
      <span data-testid="layout-marker">WAKU_AWS_LAYOUT_MARKER</span>
      {children}
    </div>
  );
}

export const getConfig = async () => ({ render: "static" }) as const;
