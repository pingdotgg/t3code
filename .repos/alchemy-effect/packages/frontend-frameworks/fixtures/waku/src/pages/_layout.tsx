import type { ReactNode } from "react";
import { Link } from "waku";
import { NavCounter } from "../components/NavCounter.tsx";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div>
      <nav>
        <Link to="/">Home</Link> <Link to="/about">About</Link>
        <NavCounter />
      </nav>
      <span data-testid="layout-marker">LAYOUT_MARKER</span>
      {children}
    </div>
  );
}

export const getConfig = async () => ({ render: "static" }) as const;
