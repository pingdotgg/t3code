import * as React from "react";

import { ansi, type ThreadStatus } from "../theme.ts";

// Status indicators for the sidebar, mirroring
// apps/web/src/components/ThreadStatusIndicators.tsx. The web renders coloured
// status pills; the TUI renders a single themed glyph (a status "dot"). These
// return <span> nodes, so they must be composed inside a <text>.

/** A themed status dot — the status glyph in the status' ANSI colour. */
export function StatusDot({ status }: { readonly status: ThreadStatus }): React.ReactNode {
  return <span fg={ansi(status.color)}>{status.glyph}</span>;
}
