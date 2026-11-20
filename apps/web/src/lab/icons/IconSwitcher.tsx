// Floating segmented control for the lab's icon mode. Own React root, so it never touches the app.
import ReactDOM from "react-dom/client";
import { ICON_MODES, setIconMode, useIconMode, type IconMode } from "./iconMode";

const LABELS: Record<IconMode, string> = {
  original: "original",
  outline: "outline",
  solid24: "solid 24",
  solid20: "solid 20",
  solid16: "solid 16",
  auto: "auto",
};

function IconSwitcher() {
  const mode = useIconMode();
  return (
    <div
      role="radiogroup"
      aria-label="Icon set"
      style={{
        position: "fixed",
        left: 8,
        bottom: 8,
        zIndex: 2147483000,
        display: "flex",
        gap: 1,
        padding: 2,
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--popover)",
        color: "var(--foreground)",
        font: "500 11px/1 Inter Variable, system-ui, sans-serif",
        opacity: 0.85,
        boxShadow: "0 1px 4px rgb(0 0 0 / 0.25)",
      }}
    >
      {ICON_MODES.map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          onClick={() => setIconMode(value)}
          style={{
            all: "unset",
            cursor: "pointer",
            padding: "5px 7px",
            borderRadius: 6,
            whiteSpace: "nowrap",
            background: mode === value ? "var(--foreground)" : "transparent",
            color: mode === value ? "var(--background)" : "inherit",
          }}
        >
          {LABELS[value]}
        </button>
      ))}
    </div>
  );
}

export function mountIconSwitcher() {
  const host = document.createElement("div");
  host.dataset.labIconSwitcher = "";
  document.body.append(host);
  ReactDOM.createRoot(host).render(<IconSwitcher />);
}
