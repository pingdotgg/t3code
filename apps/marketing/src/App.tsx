import { useState, useEffect } from "react";
import { Page1 } from "./pages/Page1";
import { Page2 } from "./pages/Page2";
import { Page3 } from "./pages/Page3";
import { Page4 } from "./pages/Page4";
import { Page5 } from "./pages/Page5";
import { Logo } from "./Logo";

const pages: Record<string, () => React.JSX.Element> = {
  "/1": Page1,
  "/2": Page2,
  "/3": Page3,
  "/4": Page4,
  "/5": Page5,
};

const labels: Record<string, string> = {
  "/1": "Cinematic",
  "/2": "Editorial",
  "/3": "Terminal",
  "/4": "Bento",
  "/5": "Minimal",
};

export function App() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const Page = pages[path];
  if (Page) return <Page />;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        gap: "2.5rem",
        padding: "2rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <Logo size={40} />
        <span style={{ fontSize: "1.5rem", fontWeight: 600, letterSpacing: "-0.02em" }}>Code</span>
      </div>
      <h1
        style={{
          fontSize: "clamp(1.5rem, 3vw, 2.5rem)",
          fontWeight: 500,
          color: "var(--fg-muted)",
          textAlign: "center",
        }}
      >
        Homepage Renditions
      </h1>
      <nav
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "1rem",
          width: "min(100%, 720px)",
        }}
      >
        {Object.keys(pages).map((p) => (
          <a
            key={p}
            href={p}
            style={{
              padding: "1.5rem",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              background: "var(--bg-subtle)",
              textAlign: "center",
              transition: "border-color 0.2s, background 0.2s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--border-strong)";
              e.currentTarget.style.background = "var(--bg-card)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--border)";
              e.currentTarget.style.background = "var(--bg-subtle)";
            }}
          >
            <div style={{ fontSize: "2rem", fontWeight: 700, marginBottom: "0.5rem" }}>{p.slice(1)}</div>
            <div style={{ fontSize: "0.85rem", color: "var(--fg-muted)" }}>{labels[p]}</div>
          </a>
        ))}
      </nav>
    </div>
  );
}
