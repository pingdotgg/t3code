import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { PreviewMoreMenu } from "./PreviewMoreMenu";

it("opens remote access controls when a page requests an unapproved port", async () => {
  const noop = vi.fn();
  await using screen = await render(
    <PreviewMoreMenu
      enabled
      actions={{
        hardReload: noop,
        setColorScheme: noop,
        zoomIn: noop,
        zoomOut: noop,
        resetZoom: noop,
        clearCookies: noop,
        clearCache: noop,
      }}
      zoomFactor={1}
      colorScheme="system"
      deviceToolbarVisible={false}
      onToggleDeviceToolbar={noop}
      nativePictureInPicture={false}
      profileName={undefined}
      remoteAccess={{
        summary: "Remote: port 3000",
        deniedPorts: [3001],
        externalAccessActive: true,
        allowPort: noop,
        copyExternalAccess: noop,
        stopExternalAccess: noop,
        turnOff: noop,
      }}
    />,
    { router: false }, // The menu has no navigation.
  );
  await userEvent.click(screen.getByRole("button", { name: "Preview menu" }));
  await userEvent.hover(screen.getByRole("menuitem", { name: "Remote access", exact: true }));
  await expect.element(screen.getByRole("menuitem", { name: "Allow port 3001" })).toBeVisible();
  await expect
    .element(screen.getByRole("menuitem", { name: "Stop other browser access" }))
    .toBeVisible();
});
