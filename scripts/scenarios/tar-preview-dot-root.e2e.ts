import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

function archiveWithRootMember() {
  const bytes = new Uint8Array(5 * 512);
  const encoder = new TextEncoder();
  const write = (offset: number, value: string) => bytes.set(encoder.encode(value), offset);
  const header = (offset: number, name: string, type: "0" | "5", size: number) => {
    write(offset, name);
    write(offset + 100, "0000755\0");
    write(offset + 124, size.toString(8).padStart(11, "0") + "\0");
    write(offset + 136, "00000000000\0");
    write(offset + 148, "        ");
    write(offset + 156, type);
    write(offset + 257, "ustar\0" + "00");
    const checksum = bytes.subarray(offset, offset + 512).reduce((sum, byte) => sum + byte, 0);
    write(offset + 148, checksum.toString(8).padStart(6, "0") + "\0 ");
  };

  const content = "Packing checklist\n";
  header(0, ".", "5", 0);
  header(512, "./checklist.txt", "0", content.length);
  write(1024, content);
  return bytes;
}

test(
  "A TAR preview does not show its root as a folder inside itself",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo", { "packing.tar": archiveWithRootMember() });
    const thread = await t3.thread({
      project,
      title: "Check archive contents",
      messages: ["Start"],
    });
    await t3.open(thread);
    await screen.getByText("fixture turn complete", { exact: false }).waitFor({ state: "visible" });

    await browser.keyboard.press("Control+p");
    await screen.getByPlaceholder("Search files…").fill("packing.tar");
    await screen.getByRole("option", "packing.tar", { exact: false }).tap();
    await screen
      .getByRole("button", "checklist.txt", { exact: true })
      .waitFor({ state: "visible", timeout: 120_000 });
    await app.screenshot("archive-root");
    expect(await browser.locator('table[aria-label="Archive entries"] tbody button').count()).toBe(
      1,
    );
  },
);
