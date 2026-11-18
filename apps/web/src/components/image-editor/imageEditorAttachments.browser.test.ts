import { expect, it } from "vite-plus/test";

import { prepareImageEditorAttachments } from "./imageEditorAttachments";
import { loadEditorImage } from "./imageEditorExport";

async function png(name: string, width: number, height: number, noisy = false) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  if (noisy) {
    const image = context.createImageData(width, height);
    let seed = 7;
    for (let index = 0; index < image.data.length; index += 4) {
      for (let channel = 0; channel < 3; channel++) {
        seed = Math.imul(seed, 1664525) + 1013904223;
        image.data[index + channel] = seed >>> 24;
      }
      image.data[index + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  } else {
    context.fillStyle = "black";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "white";
    context.fillRect(width / 2, 0, width / 2, height);
  }
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((blob) => resolve(blob!), "image/png"),
  );
  return new File([blob], name, { type: "image/png" });
}

async function decode(file: File) {
  const url = URL.createObjectURL(file);
  try {
    return await loadEditorImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

it("fits editor original, guidance and mask to the sending limit while keeping their pixels aligned and preserving session identity", async () => {
  const original = await png("original.png", 3200, 1600);
  const guidance = new File([original], "guidance.png", { type: original.type });
  const mask = new File([original], "mask.png", { type: original.type });
  const prepared = await prepareImageEditorAttachments({
    files: [original, guidance, mask],
    sessionFile: guidance,
  });
  expect(prepared.sessionFile).toBe(prepared.files[1]);
  for (const file of prepared.files) {
    const image = await decode(file);
    expect([image.naturalWidth, image.naturalHeight]).toEqual([2000, 1000]);
    const canvas = document.createElement("canvas");
    canvas.width = 2000;
    canvas.height = 1000;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    expect([...context.getImageData(500, 500, 1, 1).data]).toEqual([0, 0, 0, 255]);
    expect([...context.getImageData(1500, 500, 1, 1).data]).toEqual([255, 255, 255, 255]);
  }
  const source = await decode(original);
  expect([source.naturalWidth, source.naturalHeight]).toEqual([3200, 1600]);
});

it("aligns a simple mask with a photo when byte compression needs a smaller image", async () => {
  const original = await png("original.png", 512, 256, true);
  const guidance = new File([original], "guidance.png", { type: original.type });
  const mask = await png("mask.png", 512, 256);
  const prepared = await prepareImageEditorAttachments(
    { files: [original, guidance, mask], sessionFile: guidance },
    30_000,
  );
  const sizes = [];
  for (const file of prepared.files) {
    expect(file.size).toBeLessThanOrEqual(30_000);
    const image = await decode(file);
    sizes.push([image.naturalWidth, image.naturalHeight]);
  }
  expect(sizes[0]![0]).toBeLessThan(512);
  expect(sizes[1]).toEqual(sizes[0]);
  expect(sizes[2]).toEqual(sizes[0]);
});

it("keeps a supported animation intact and rejects an oversized GIF instead of flattening it", async () => {
  const bytes = Uint8Array.from(
    atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
    (char) => char.charCodeAt(0),
  );
  const animation = new File([bytes], "animation.gif", { type: "image/gif" });
  expect((await prepareImageEditorAttachments({ files: [animation] })).files[0]).toBe(animation);
  new DataView(bytes.buffer).setUint16(6, 2001, true);
  const oversized = new File([bytes], "opaque-image", { type: "application/octet-stream" });
  await expect(prepareImageEditorAttachments({ files: [oversized] })).rejects.toThrow(
    "Resize the animation",
  );
});
