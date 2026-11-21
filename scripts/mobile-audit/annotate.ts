// @effect-diagnostics nodeBuiltinImport:off - Host-side image rendering uses Node filesystem APIs directly.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import sharp from "sharp";

import type { OverlayBox } from "./diff.ts";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function renderAnnotatedPanel(input: {
  readonly pngPath: string;
  readonly boxes: ReadonlyArray<OverlayBox>;
  readonly bannerText: string;
  readonly bannerBg: string;
  readonly viewport?: { readonly width: number; readonly height: number } | undefined;
  readonly targetWidth: number;
}): Promise<{ readonly buffer: Buffer; readonly width: number; readonly height: number }> {
  const meta = await sharp(input.pngPath).metadata();
  const srcWidth = meta.width ?? input.targetWidth;
  const srcHeight = meta.height ?? input.targetWidth * 2;
  const coordScaleX = input.viewport?.width ? srcWidth / input.viewport.width : 1;
  const coordScaleY = input.viewport?.height ? srcHeight / input.viewport.height : 1;

  const scale = input.targetWidth / srcWidth;
  const targetHeight = Math.round(srcHeight * scale);
  const bannerHeight = 44;

  const rectsSvg = input.boxes
    .map((box) => {
      const rx = Math.round(box.x * coordScaleX * scale);
      const ry = Math.round(box.y * coordScaleY * scale);
      const rw = Math.max(8, Math.round(box.width * coordScaleX * scale));
      const rh = Math.max(8, Math.round(box.height * coordScaleY * scale));
      const stroke = box.color;
      const fill = stroke === "#16a34a" ? "rgba(22,163,74,0.14)" : "rgba(239,68,68,0.16)";
      const tag = box.tag;
      const tagW = Math.min(
        input.targetWidth - 12,
        Math.max(46, Math.round(tag.length * 7.2 + 14)),
      );
      const tagH = 20;
      let tx = Math.min(input.targetWidth - tagW - 4, Math.max(4, rx));
      let ty = ry - tagH - 2;
      if (ty < 4) ty = Math.min(targetHeight - tagH - 4, ry + rh + 2);
      if (box.tagSide === "right") {
        tx = Math.min(input.targetWidth - tagW - 4, rx + rw - tagW);
      } else if (box.tagSide === "below") {
        ty = Math.min(targetHeight - tagH - 4, ry + rh + 2);
      } else if (box.tagSide === "inside-right") {
        tx = Math.min(input.targetWidth - tagW - 4, rx + rw - tagW - 4);
        ty = Math.max(4, ry + Math.round((rh - tagH) / 2));
      }
      return [
        `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="5" fill="${fill}" stroke="${stroke}" stroke-width="2.5" />`,
        tag
          ? `<rect x="${tx}" y="${ty}" width="${tagW}" height="${tagH}" rx="4" fill="${stroke}" />` +
            `<text x="${tx + 7}" y="${ty + 14}" font-family="DejaVu Sans, Arial, sans-serif" font-size="11.5" font-weight="700" fill="#ffffff">${escapeXml(tag)}</text>`
          : "",
      ].join("");
    })
    .join("\n");

  const overlaySvg = Buffer.from(
    `<svg width="${input.targetWidth}" height="${targetHeight}" xmlns="http://www.w3.org/2000/svg">${rectsSvg}</svg>`,
  );

  const annotatedImg = await sharp(input.pngPath)
    .resize(input.targetWidth, targetHeight)
    .composite([{ input: overlaySvg, top: 0, left: 0 }])
    .png()
    .toBuffer();

  const headerSvg = Buffer.from(
    `<svg width="${input.targetWidth}" height="${bannerHeight}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${input.targetWidth}" height="${bannerHeight}" fill="${input.bannerBg}" />` +
      `<text x="${input.targetWidth / 2}" y="28" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="15" font-weight="700" fill="#ffffff">${escapeXml(input.bannerText)}</text>` +
      `</svg>`,
  );

  const combined = await sharp({
    create: {
      width: input.targetWidth,
      height: targetHeight + bannerHeight,
      channels: 4,
      background: { r: 24, g: 24, b: 27, alpha: 1 },
    },
  })
    .composite([
      { input: headerSvg, top: 0, left: 0 },
      { input: annotatedImg, top: bannerHeight, left: 0 },
    ])
    .png()
    .toBuffer();

  return { buffer: combined, width: input.targetWidth, height: targetHeight + bannerHeight };
}

export async function renderSingleAnnotatedImage(input: {
  readonly pngPath: string;
  readonly boxes: ReadonlyArray<OverlayBox>;
  readonly bannerText: string;
  readonly bannerBg: string;
  readonly viewport?: { readonly width: number; readonly height: number } | undefined;
  readonly outPath: string;
  readonly targetWidth?: number | undefined;
}): Promise<void> {
  const panel = await renderAnnotatedPanel({
    pngPath: input.pngPath,
    boxes: input.boxes,
    bannerText: input.bannerText,
    bannerBg: input.bannerBg,
    viewport: input.viewport,
    targetWidth: input.targetWidth ?? 540,
  });
  await NodeFSP.mkdir(NodePath.dirname(input.outPath), { recursive: true });
  await NodeFSP.writeFile(input.outPath, panel.buffer);
}

export async function renderBeforeAfterComparison(input: {
  readonly beforePng: string;
  readonly beforeBoxes: ReadonlyArray<OverlayBox>;
  readonly beforeTitle: string;
  readonly beforeViewport?: { readonly width: number; readonly height: number } | undefined;
  readonly afterPng: string;
  readonly afterBoxes: ReadonlyArray<OverlayBox>;
  readonly afterTitle: string;
  readonly afterBannerBg?: string | undefined;
  readonly afterViewport?: { readonly width: number; readonly height: number } | undefined;
  readonly outPath: string;
  readonly panelWidth?: number | undefined;
}): Promise<{ readonly width: number; readonly height: number }> {
  const targetWidth = input.panelWidth ?? 540;
  const [left, right] = await Promise.all([
    renderAnnotatedPanel({
      pngPath: input.beforePng,
      boxes: input.beforeBoxes,
      bannerText: input.beforeTitle,
      bannerBg: "#b91c1c",
      viewport: input.beforeViewport,
      targetWidth,
    }),
    renderAnnotatedPanel({
      pngPath: input.afterPng,
      boxes: input.afterBoxes,
      bannerText: input.afterTitle,
      bannerBg: input.afterBannerBg ?? "#15803d",
      viewport: input.afterViewport,
      targetWidth,
    }),
  ]);

  const gap = 16;
  const pad = 16;
  const width = left.width + right.width + gap + pad * 2;
  const height = Math.max(left.height, right.height) + pad * 2;

  await NodeFSP.mkdir(NodePath.dirname(input.outPath), { recursive: true });
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 24, g: 24, b: 27, alpha: 1 },
    },
  })
    .composite([
      { input: left.buffer, top: pad, left: pad },
      { input: right.buffer, top: pad, left: pad + left.width + gap },
    ])
    .png()
    .toFile(input.outPath);

  return { width, height };
}
