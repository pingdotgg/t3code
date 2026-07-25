import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PROLONGED_SERVICE_UPDATE_MS, ServiceUpdateBannerView } from "./ServiceUpdateBanner";

const STARTED_AT = "2026-07-25T13:23:25.000Z";
const DRAINING_STATE = {
  status: "draining" as const,
  targetVersion: "0.0.28-f8y.20260725.33",
  activeTurnCount: 3,
  queuedTurnCount: 2,
  queuedTurns: [
    { threadId: "thread-1" as never, messageId: "message-1" as never },
    { threadId: "thread-2" as never, messageId: "message-2" as never },
  ],
  startedAt: STARTED_AT,
};

describe("ServiceUpdateBannerView", () => {
  it("shows target version and live active and queued counts", () => {
    const markup = renderToStaticMarkup(
      <ServiceUpdateBannerView state={DRAINING_STATE} nowMs={Date.parse(STARTED_AT)} />,
    );

    expect(markup).toContain("T3 Code is updating to 0.0.28-f8y.20260725.33");
    expect(markup).toContain("after 3 active turns finish");
    expect(markup).toContain("2 turns are queued.");
    expect(markup).not.toContain("Cancel update");
  });

  it("warns and offers cancellation after a prolonged drain", () => {
    const markup = renderToStaticMarkup(
      <ServiceUpdateBannerView
        state={DRAINING_STATE}
        nowMs={Date.parse(STARTED_AT) + PROLONGED_SERVICE_UPDATE_MS}
        onCancel={() => {}}
      />,
    );

    expect(markup).toContain("taking longer than expected");
    expect(markup).toContain("Cancel update");
  });

  it("clears for idle state", () => {
    expect(
      renderToStaticMarkup(
        <ServiceUpdateBannerView state={{ status: "idle" }} nowMs={Date.parse(STARTED_AT)} />,
      ),
    ).toBe("");
  });
});
