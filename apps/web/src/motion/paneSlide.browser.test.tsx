import { useRef } from "react";
import { describe, expect, it } from "vite-plus/test";

import { render, stubGlobal } from "../../test/render";
import { MotionAnimation } from "./animation";
import { usePaneMotion } from "./paneMotion";

function Strip({ x }: { x: number }) {
  const stage = useRef<HTMLDivElement>(null);
  usePaneMotion(stage, "workspace", true, () => {}, x, 400);
  return (
    <div style={{ width: "400px", height: "200px", overflow: "hidden" }}>
      <div ref={stage} style={{ position: "relative", width: "1200px", height: "200px" }}>
        <div
          data-layout-pane-id="pane"
          data-layout-tab-id="tab"
          style={{ position: "absolute", left: `${x}px`, top: 0, width: "200px", height: "200px" }}
        />
      </div>
    </div>
  );
}

const slideAnimation = (container: HTMLElement) => {
  const pane = container.querySelector<HTMLElement>("[data-layout-tab-id]")!;
  return pane.getAnimations();
};

describe("usePaneMotion", () => {
  it("retargets a slide by less than a device pixel below 1x zoom", async () => {
    using _ratio = stubGlobal("devicePixelRatio", 0.75);
    await using screen = await render(<Strip x={0} />);
    await screen.rerender(<Strip x={100} />);

    const [running] = slideAnimation(screen.container);
    expect(running).toBeDefined();
    const motion = MotionAnimation.start("window-movement", 1, 0);
    let elapsed = 0;
    let shows = 0;
    for (; elapsed < motion.durationMs; elapsed += 0.25) {
      shows = 100 - 100 * motion.valueAt(elapsed);
      const fraction = shows - Math.floor(shows);
      if (fraction > 0.55 && fraction < 0.6) break;
    }
    expect(elapsed).toBeLessThan(motion.durationMs);
    running!.pause();
    running!.currentTime = elapsed;

    await screen.rerender(<Strip x={Math.floor(shows)} />);

    expect(slideAnimation(screen.container)).toHaveLength(0);
  });
});
