import type { ReactElement } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { SettingsEnvironmentSelector } from "./SettingsEnvironmentSelector";

describe("SettingsEnvironmentSelector", () => {
  it("renders a non-interactive status dot inside each environment button", () => {
    const environmentId = EnvironmentId.make("remote-device");
    const selector = SettingsEnvironmentSelector({
      environments: [
        {
          environmentId,
          label: "Remote device",
          displayUrl: null,
          relayManaged: true,
          entry: { target: { _tag: "RelayConnectionTarget" } },
          connection: { phase: "connected", error: null, traceId: null },
          serverConfig: null,
        },
      ] as unknown as Parameters<typeof SettingsEnvironmentSelector>[0]["environments"],
      isReady: true,
      selectedEnvironmentId: environmentId,
      emptyDescription: "Connect an environment.",
      onSelect: () => undefined,
    }) as ReactElement<Record<string, unknown>>;

    const statusDot = visitElements(selector, (element) => element.type === ConnectionStatusDot);
    expect(statusDot?.props.tooltipText).toBeUndefined();
  });
});
