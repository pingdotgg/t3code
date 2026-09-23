/**
 * Voice history surface rendering (static markup, the repo's
 * dumb-component test pattern): the saved-session count collapsed by
 * default, the expanded review list with per-session delete, export and
 * clear, and the frozen state while a session is live.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { VoiceHistory } from "./VoiceHistory";
import type { VoiceHistorySessionSummary } from "../history";

const summary = (
  id: string,
  startedAt: number,
  entryCount: number,
): VoiceHistorySessionSummary => ({
  id,
  startedAt,
  entryCount,
});

const render = (props: {
  sessions: ReadonlyArray<VoiceHistorySessionSummary>;
  open?: boolean;
  frozen?: boolean;
}) =>
  renderToStaticMarkup(
    <VoiceHistory
      sessions={props.sessions}
      open={props.open ?? false}
      onToggle={() => {}}
      frozen={props.frozen ?? false}
      onExport={() => {}}
      onClear={() => {}}
      onDelete={() => {}}
    />,
  );

describe("voice history rendering", () => {
  it("renders nothing when no sessions are saved", () => {
    expect(render({ sessions: [] })).toBe("");
  });

  it("shows the saved session count collapsed by default", () => {
    const markup = render({ sessions: [summary("a", 1000, 3), summary("b", 2000, 5)] });
    expect(markup).toContain("History (2)");
    expect(markup).not.toContain("Export history");
  });

  it("lists sessions with delete, export, and clear when expanded", () => {
    const markup = render({
      sessions: [summary("a", 1000, 3), summary("b", 2000, 5)],
      open: true,
    });
    expect(markup).toContain("Export history");
    expect(markup).toContain("Clear history");
    expect(markup.match(/>Delete</g)?.length).toBe(2);
    expect(markup.match(/disabled="/g)?.length ?? 0).toBe(0);
  });

  it("freezes clear and delete while a session is live; export stays enabled", () => {
    const markup = render({ sessions: [summary("a", 1000, 3)], open: true, frozen: true });
    // Exactly the per-session delete and the clear-all buttons are disabled.
    expect(markup.match(/disabled="/g)?.length).toBe(2);
    expect(markup).toContain("Export history");
  });
});
