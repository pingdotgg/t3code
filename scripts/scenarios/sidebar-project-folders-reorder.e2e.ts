import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Project folders can be dragged into a saved order",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const alpha = await t3.project("alpha");
    const beta = await t3.project("beta");
    await t3.thread({ project: alpha, title: "Alpha thread", messages: ["Start"] });
    const thread = await t3.thread({ project: beta, title: "Beta thread", messages: ["Start"] });
    await t3.open(thread);

    const threadPath = await browser.evaluate(() => location.pathname);
    await app.open("/settings/labs");
    await screen.getByRole("switch", "Boring sidebar (group by project)").tap();
    await app.open(threadPath);

    const alphaFolder = screen.getByRole("button", "alpha");
    const betaFolder = screen.getByRole("button", "beta");
    await expect(alphaFolder).toBeVisible();
    await expect(betaFolder).toBeVisible();
    const source = (await betaFolder.boundingBox())!;
    const target = (await alphaFolder.boundingBox())!;
    expect(source.y).toBeLessThan(target.y);
    const x = source.x + 12;
    const y = source.y + source.height / 2;
    const startDrag = async (fromY: number) => {
      await browser.mouse.move(x, fromY);
      await browser.mouse.down();
      await browser.mouse.move(x, fromY + 8);
    };
    const folderGapY = () =>
      browser.evaluate(() => {
        const [first, second] = document.querySelectorAll("[data-sidebar-folder-group]");
        return (first!.getBoundingClientRect().bottom + second!.getBoundingClientRect().top) / 2;
      });
    const gapY = await folderGapY();
    await startDrag(y);
    await browser.mouse.move(x, gapY);
    await app.screenshot("drag-between-folders");
    const dragged = (await betaFolder.boundingBox())!;
    expect.soft(Math.abs(dragged.y + source.height / 2 - gapY)).toBeLessThan(2);
    await browser.mouse.move(x, target.y + target.height / 2);
    await browser.mouse.up();

    const alphaComesFirst = async () => {
      const first = await alphaFolder.boundingBox();
      const second = await betaFolder.boundingBox();
      return first !== null && second !== null && first.y < second.y;
    };
    await app.screenshot("project-order");
    await expect.poll(alphaComesFirst).toBe(true);
    await expect(betaFolder).toHaveAttribute("aria-expanded", "true");
    await browser.reload();
    await expect.poll(alphaComesFirst).toBe(true);
    await app.screenshot("project-order-after-reload");

    const viewport = await browser.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      footerHeight: document.querySelector('[data-sidebar="footer"]')!.getBoundingClientRect()
        .height,
    }));
    const betaAfterReload = (await betaFolder.boundingBox())!;
    const outsideY = betaAfterReload.y + betaAfterReload.height / 2;
    await browser.setViewport({
      width: viewport.width,
      height: Math.round(outsideY + viewport.footerHeight / 2),
    });
    expect(
      await browser.evaluate(
        (point) =>
          Boolean(document.elementFromPoint(point.x, point.y)?.closest('[data-sidebar="footer"]')),
        { x, y: outsideY },
      ),
    ).toBe(true);
    const alphaAfterResize = (await alphaFolder.boundingBox())!;
    await startDrag(alphaAfterResize.y + alphaAfterResize.height / 2);
    await browser.mouse.move(x, outsideY);
    await browser.mouse.up();
    await browser.setViewport({ width: viewport.width, height: viewport.height });
    await browser.reload();
    await expect.poll(alphaComesFirst).toBe(true);

    const releaseGapY = await folderGapY();
    const alphaBeforeRelease = (await alphaFolder.boundingBox())!;
    const betaBeforeRelease = (await betaFolder.boundingBox())!;
    await startDrag(alphaBeforeRelease.y + alphaBeforeRelease.height / 2);
    await browser.mouse.move(x, betaBeforeRelease.y + betaBeforeRelease.height / 2);
    await expect
      .poll(async () => (await betaFolder.boundingBox())?.y ?? betaBeforeRelease.y)
      .toBeLessThan(betaBeforeRelease.y);
    // Release in the gap while dnd-kit still holds the previous hover target.
    await browser.evaluate(
      ({ x, y }) =>
        document.dispatchEvent(
          new PointerEvent("pointerup", { pointerId: 1, clientX: x, clientY: y }),
        ),
      { x, y: releaseGapY },
    );
    await browser.mouse.up();
    await browser.reload();
    await expect.poll(alphaComesFirst).toBe(true);
  },
);
