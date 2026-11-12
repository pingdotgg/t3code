import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chosenPluginUiEnvironments,
  hidesPluginUiChoice,
  withPluginUiChoice,
} from "./pluginFollow";

describe("plugin UI choices", () => {
  it("loads the main environment until it is turned off, and others only once turned on", () => {
    const main = EnvironmentId.make("environment:main");
    const remote = EnvironmentId.make("environment:remote");
    const other = EnvironmentId.make("environment:other");
    const none = new Map<EnvironmentId, boolean>();

    expect(chosenPluginUiEnvironments(none, main)).toEqual([main]);
    expect(chosenPluginUiEnvironments(none, null)).toEqual([]);
    const both = withPluginUiChoice(
      withPluginUiChoice(none, other, true, main),
      remote,
      true,
      main,
    );
    // The main environment first, then the others in the order chosen.
    expect(chosenPluginUiEnvironments(both, main)).toEqual([main, other, remote]);
    const mainOff = withPluginUiChoice(both, main, false, main);
    expect(chosenPluginUiEnvironments(mainOff, main)).toEqual([other, remote]);
    expect(withPluginUiChoice(mainOff, main, true, main)).toEqual(both);
    // Settings hides the choice while the main environment is the only option and is on, and
    // keeps it while the main environment is off so it can be turned back on.
    expect(hidesPluginUiChoice(none, [main], main)).toBe(true);
    expect(hidesPluginUiChoice(mainOff, [main], main)).toBe(false);
    expect(hidesPluginUiChoice(none, [main, remote], main)).toBe(false);
  });
});
