import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { PluginReplaceable } from "./PluginReplaceable";
import {
  type PluginPartName,
  pluginPartNotesAtom,
  pluginReplacementAtoms,
  pluginWebFailuresAtom,
  registerPluginReplacement,
} from "./pluginRegistry";

const original = <p>T3 controls</p>;
const owner = {
  environmentId: EnvironmentId.make("environment:parts"),
  pluginId: "restyle",
  pluginName: "Restyle",
};

const controls = () => (
  <AppAtomRegistryProvider>
    <PluginReplaceable
      part="composer.controls"
      pieces={{
        original,
        attach: <span>Attach</span>,
        controls: null,
        model: <span>Model</span>,
        effort: null,
        access: null,
        actions: <span>Send</span>,
      }}
    />
  </AppAtomRegistryProvider>
);

describe("PluginReplaceable", () => {
  it("draws the newest replacement and brings back the previous one when it unloads", async () => {
    using _first = {
      [Symbol.dispose]: registerPluginReplacement(
        "composer.controls",
        (pieces) => (
          <p>
            First: {pieces.model}
            {pieces.actions}
          </p>
        ),
        owner,
      ),
    };
    const unregisterSecond = registerPluginReplacement(
      "composer.controls",
      (pieces) => <p>Second: {pieces.attach}</p>,
      owner,
    );
    using _second = { [Symbol.dispose]: unregisterSecond };
    await using _screen = await render(controls());

    await expect.element(page.getByText("Second: Attach")).toBeVisible();
    unregisterSecond();
    await expect.element(page.getByText("First: ModelSend")).toBeVisible();
    // Another plugin loading later doesn't take over: the id that sorts first keeps the part.
    using _later = {
      [Symbol.dispose]: registerPluginReplacement("composer.controls", () => <p>Later plugin</p>, {
        ...owner,
        pluginId: "zz-later",
      }),
    };
    expect(appAtomRegistry.get(pluginReplacementAtoms["composer.controls"])?.owner.pluginId).toBe(
      "restyle",
    );
    expect(appAtomRegistry.get(pluginPartNotesAtom("zz-later")).get(owner.environmentId)).toEqual([
      "Restyle draws the composer's control row instead.",
    ]);
    // A part this T3 doesn't have, such as one a newer T3 renamed, is skipped without failing.
    using _renamed = {
      [Symbol.dispose]: registerPluginReplacement(
        "composer.footer" as PluginPartName,
        () => <p>Renamed</p>,
        owner,
      ),
    };
    expect(appAtomRegistry.get(pluginPartNotesAtom("restyle")).get(owner.environmentId)).toEqual([
      'This version of T3 Code has no "composer.footer" part to draw.',
    ]);
  });

  it("draws T3's own part when the replacement throws, and says so on the plugin's row", async () => {
    using _replacement = {
      [Symbol.dispose]: registerPluginReplacement(
        "composer.controls",
        () => {
          throw new Error("boom");
        },
        owner,
      ),
    };
    await using _screen = await render(controls());

    await expect.element(page.getByText("T3 controls")).toBeVisible();
    expect(
      appAtomRegistry.get(pluginWebFailuresAtom(owner.pluginId)).get(owner.environmentId),
    ).toContain("(composer.controls) stopped with an error: boom");
  });
});
