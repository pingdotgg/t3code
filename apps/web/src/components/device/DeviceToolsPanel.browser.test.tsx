import type { DeviceSummary } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { DeviceToolsPanel } from "./DeviceToolsPanel";
import type { DeviceControls } from "./useDeviceControls";

const device: DeviceSummary = {
  hostId: "local",
  id: "emulator",
  name: "Pixel",
  platform: "android",
  version: "Android 15",
  booted: true,
  physical: false,
};

it("keeps a typed URL until opening it succeeds", async () => {
  const run = vi
    .fn<DeviceControls["act"]>()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  const controls: DeviceControls = {
    detail: null,
    pending: false,
    error: null,
    act: run,
    disabled: false,
    foregroundApp: null,
  };
  await using screen = await render(
    <DeviceToolsPanel
      controls={controls}
      hostDiagnostics={undefined}
      device={device}
      access={null}
      axOverlay={false}
      onAxOverlayChange={() => {}}
      onClose={() => {}}
    />,
  );
  const url = "myapp://settings";
  const field = screen.getByPlaceholder("https://… or myapp://");
  const open = screen.getByRole("button", { name: "Open" });

  await userEvent.fill(field, url);
  await userEvent.click(open);
  await act(() => run.mock.results[0]?.value);
  await expect.element(field).toHaveValue(url);

  await userEvent.click(open);
  await expect.element(field).toHaveValue("");
});
