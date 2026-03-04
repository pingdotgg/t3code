import { expect, test, type Page } from "@playwright/test";

import { estimateTimelineMessageHeight } from "../src/components/timelineHeight";

interface HeightCase {
  timelineWidthPx: number;
  text: string;
  attachmentCount: number;
}

async function measureUserRowHeight(page: Page, testCase: HeightCase) {
  const { timelineWidthPx, text, attachmentCount } = testCase;
  await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");

  return page.evaluate(({ width, messageText, attachments }) => {
    const timeline = document.createElement("div");
    timeline.style.width = `${width}px`;
    timeline.style.maxWidth = `${width}px`;

    const row = document.createElement("div");
    row.style.paddingBottom = "16px";

    const alignment = document.createElement("div");
    alignment.style.display = "flex";
    alignment.style.justifyContent = "flex-end";

    const bubble = document.createElement("div");
    bubble.style.boxSizing = "border-box";
    bubble.style.maxWidth = "80%";
    bubble.style.padding = "12px 16px";
    bubble.style.border = "1px solid rgba(0, 0, 0, 0.12)";
    bubble.style.borderRadius = "16px";
    bubble.style.background = "rgba(0, 0, 0, 0.03)";

    if (attachments > 0) {
      const attachmentGrid = document.createElement("div");
      attachmentGrid.style.marginBottom = "8px";
      attachmentGrid.style.maxWidth = "420px";
      attachmentGrid.style.display = "grid";
      attachmentGrid.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
      attachmentGrid.style.gap = "8px";
      for (let index = 0; index < attachments; index += 1) {
        const tile = document.createElement("div");
        tile.style.height = "220px";
        tile.style.border = "1px solid rgba(0, 0, 0, 0.12)";
        tile.style.borderRadius = "8px";
        tile.style.background = "rgba(0, 0, 0, 0.06)";
        attachmentGrid.append(tile);
      }
      bubble.append(attachmentGrid);
    }

    if (messageText.length > 0) {
      const pre = document.createElement("pre");
      pre.textContent = messageText;
      pre.style.margin = "0";
      pre.style.whiteSpace = "pre-wrap";
      pre.style.overflowWrap = "anywhere";
      pre.style.fontFamily =
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace";
      pre.style.fontSize = "14px";
      pre.style.lineHeight = "22px";
      bubble.append(pre);
    }

    const meta = document.createElement("div");
    meta.style.marginTop = "6px";
    meta.style.height = "16px";
    bubble.append(meta);

    alignment.append(bubble);
    row.append(alignment);
    timeline.append(row);
    document.body.append(timeline);
    return row.getBoundingClientRect().height;
  }, { width: timelineWidthPx, messageText: text, attachments: attachmentCount });
}

function estimatedHeight(testCase: HeightCase): number {
  return estimateTimelineMessageHeight(
    {
      role: "user",
      text: testCase.text,
      attachments: Array.from({ length: testCase.attachmentCount }, (_value, index) => ({
        id: String(index),
      })),
    },
    { timelineWidthPx: testCase.timelineWidthPx },
  );
}

test.describe("timeline height estimator parity", () => {
  test("tracks long wrapped text growth at desktop width", async ({ page }) => {
    const baselineCase: HeightCase = { timelineWidthPx: 960, text: "", attachmentCount: 0 };
    const longCase: HeightCase = {
      timelineWidthPx: 960,
      text: "x".repeat(1200),
      attachmentCount: 0,
    };

    const baselineMeasured = await measureUserRowHeight(page, baselineCase);
    const longMeasured = await measureUserRowHeight(page, longCase);
    const measuredDelta = longMeasured - baselineMeasured;

    const estimatedDelta = estimatedHeight(longCase) - estimatedHeight(baselineCase);
    expect(Math.abs(measuredDelta - estimatedDelta)).toBeLessThanOrEqual(22);
  });

  test("tracks additional wrapping when viewport narrows", async ({ page }) => {
    const desktopCase: HeightCase = {
      timelineWidthPx: 960,
      text: "x".repeat(1000),
      attachmentCount: 0,
    };
    const mobileCase: HeightCase = {
      timelineWidthPx: 360,
      text: desktopCase.text,
      attachmentCount: 0,
    };

    const desktopMeasured = await measureUserRowHeight(page, desktopCase);
    const mobileMeasured = await measureUserRowHeight(page, mobileCase);
    const measuredDelta = mobileMeasured - desktopMeasured;

    const estimatedDelta = estimatedHeight(mobileCase) - estimatedHeight(desktopCase);
    expect(Math.abs(measuredDelta - estimatedDelta)).toBeLessThanOrEqual(44);
  });

  test("tracks attachment row growth", async ({ page }) => {
    const withoutAttachmentsCase: HeightCase = {
      timelineWidthPx: 960,
      text: "hello",
      attachmentCount: 0,
    };
    const withAttachmentsCase: HeightCase = {
      ...withoutAttachmentsCase,
      attachmentCount: 3,
    };

    const withoutMeasured = await measureUserRowHeight(page, withoutAttachmentsCase);
    const withMeasured = await measureUserRowHeight(page, withAttachmentsCase);
    const measuredDelta = withMeasured - withoutMeasured;

    const estimatedDelta =
      estimatedHeight(withAttachmentsCase) - estimatedHeight(withoutAttachmentsCase);
    expect(Math.abs(measuredDelta - estimatedDelta)).toBeLessThanOrEqual(4);
  });
});
