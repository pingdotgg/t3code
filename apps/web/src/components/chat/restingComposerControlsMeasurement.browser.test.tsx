import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { resolveRestingComposerControlsLayout } from "../composerFooterLayout";
import { measureRestingComposerControls } from "./restingComposerControlsMeasurement";

it("reserves visible profile width before deciding whether resting controls fit", async () => {
  function controls(profile: "visible" | "hidden" | "absent") {
    return (
      <div data-testid="controls" style={{ display: "flex", gap: 4 }}>
        <button data-chat-provider-model-picker style={{ width: 100, minWidth: 52 }} />
        {profile !== "absent" && (
          <div
            data-composer-profile-picker
            style={{ display: profile === "hidden" ? "none" : "flex", width: 80 }}
          />
        )}
      </div>
    );
  }
  await using screen = await render(controls("visible"));
  for (const profile of ["visible", "hidden", "absent"] as const) {
    await screen.rerender(controls(profile));
    const measurement = measureRestingComposerControls(
      screen.container.querySelector<HTMLElement>('[data-testid="controls"]')!,
    );
    expect(measurement).not.toBeNull();
    expect(measurement?.naturalFixedWidth).toBe(profile === "visible" ? 184 : 100);
    expect(measurement?.minimumFixedWidth).toBe(profile === "visible" ? 136 : 52);
    expect(resolveRestingComposerControlsLayout({ ...measurement!, hostWidth: 110 }).visible).toBe(
      profile !== "visible",
    );
  }
});
