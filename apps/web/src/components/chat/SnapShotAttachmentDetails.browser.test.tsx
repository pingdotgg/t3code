import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { SnapShotAttachmentDetails } from "./SnapShotAttachmentDetails";

it("keeps a leading emoji whole in the app avatar fallback", async () => {
  await using screen = await render(
    <SnapShotAttachmentDetails
      source={{
        kind: "snap-shot",
        capturedAt: "2026-01-01T00:00:00.000Z",
        appName: "🚀 Rocket",
        windowTitle: "Launch",
      }}
    />,
  );

  await expect.element(screen.getByText("🚀", { exact: true })).toBeVisible();
});
