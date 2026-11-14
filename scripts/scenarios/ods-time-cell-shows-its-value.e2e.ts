import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

// A valid ODS whose only cell is typed time with no optional <text:p> display paragraph.
const TIME_ONLY_ODS =
  "UEsDBAoAAAAAACdXbl2FbDmKLgAAAC4AAAAIAAAAbWltZXR5cGVhcHBsaWNhdGlvbi92bmQub2FzaXMub3BlbmRvY3VtZW50LnNwcmVhZHNoZWV0UEsDBAoAAAAAACdXbl0AAAAAAAAAAAAAAAAJAAAATUVUQS1JTkYvUEsDBAoAAAAIACdXbl3Rr5gOtgAAAHABAAAVAAAATUVUQS1JTkYvbWFuaWZlc3QueG1sjZDRCsIwDEV/ZeR9q+KLlFXf/AL9gNJmWmjTsmZj+3ur4JyI4FtCcu+5SXucgq9G7LOLpGDbbKBCMtE6uiq4nE/1Ho6HNmhyHWaWr6IqMspLq2DoSUadXZakA2bJRsaEZKMZAhLLz335BC3dir+DFa1zHuui7uf3bjd4XyfNNwViZRHQOl3znFCBTsk7o7lYipFs88zVrOM0OfWobb4hMoj/iSYSP+Tlmh9sxonFY1xcxdfbDndQSwMECgAAAAgAJ1duXZwajlHfAAAACgIAAAsAAABjb250ZW50LnhtbI2RwWrDMAyGXyXo7sUjl2Hi9DZ6GQzaPYDrKKvBkULsbO3bz423kLANerEt6f/0S7jeXXpffOAYHJOGxwcJBZLl1tG7hrfjs3iCXVNz1zmLqmU79UhRWKaY7iLBFFSuaphGUmyCC4pMj0FFq3hA+qHUWq1mq5yJ5uTvxmfxhsZLvBtO2sx+T7HavIJlzxO31yUIw4imDWfE2NTZfT6L/L7ZaTicXRcDbARi5M9twqL3i7PxE4p4HRIdXY/LSLdAzFUNr0dZ7Sv5IuUByqYuf3VfZ1L018jlZqnyn69svgBQSwECFAAKAAAAAAAnV25dhWw5ii4AAAAuAAAACAAAAAAAAAAAAAAAAAAAAAAAbWltZXR5cGVQSwECFAAKAAAAAAAnV25dAAAAAAAAAAAAAAAACQAAAAAAAAAAABAAAABUAAAATUVUQS1JTkYvUEsBAhQACgAAAAgAJ1duXdGvmA62AAAAcAEAABUAAAAAAAAAAAAAAAAAewAAAE1FVEEtSU5GL21hbmlmZXN0LnhtbFBLAQIUAAoAAAAIACdXbl2cGo5R3wAAAAoCAAALAAAAAAAAAAAAAAAAAGQBAABjb250ZW50LnhtbFBLBQYAAAAABAAEAOkAAABsAgAAAAA=";

test(
  "An ODS time cell without a display paragraph shows its value",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo", {
      "shifts.ods": Buffer.from(TIME_ONLY_ODS, "base64"),
    });
    const thread = await t3.thread({ project, title: "Shifts", messages: ["Start"] });
    await t3.open(thread);

    await screen.getByRole("button", "Toggle right panel").tap();
    await screen.getByRole("button", "Files F").tap();
    await screen.getByRole("treeitem", "shifts.ods").tap();
    // A cold Vite cache reloads the page the first time the office preview loads.
    await expect(screen.getByText("Sheet 1 of 1", { exact: false })).toBeVisible({
      timeout: 60_000,
    });
    await app.screenshot("sheet");
    await expect(screen.getByText("PT03H30M00S")).toBeVisible();
  },
);
