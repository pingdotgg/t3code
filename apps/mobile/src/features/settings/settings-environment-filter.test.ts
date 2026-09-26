import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { toggleSettingsEnvironment } from "./settings-environment-filter.logic";

const first = "first" as EnvironmentId;
const second = "second" as EnvironmentId;
const connected = [{ environmentId: first }, { environmentId: second }];

describe("settings environment filter", () => {
  it("starts with all connected environments and can narrow to either or neither", () => {
    const withoutFirst = toggleSettingsEnvironment(null, connected, first);
    expect([...withoutFirst!]).toEqual([second]);

    const none = toggleSettingsEnvironment(withoutFirst, connected, second);
    expect([...none!]).toEqual([]);

    const onlyFirst = toggleSettingsEnvironment(none, connected, first);
    expect([...onlyFirst!]).toEqual([first]);

    expect(toggleSettingsEnvironment(onlyFirst, connected, second)).toBeNull();
  });

  it("drops environments that are no longer connected when the selection changes", () => {
    const onlyFirst = new Set([first]);
    expect(toggleSettingsEnvironment(onlyFirst, [{ environmentId: second }], first)).toEqual(
      new Set(),
    );
  });
});
