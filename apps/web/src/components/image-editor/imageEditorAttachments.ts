import { m } from "~/i18n/messages";
import { msg } from "gt-react";
import { IMAGE_ATTACHMENT_MAX_EDGE } from "@t3tools/client-runtime/image-attachment-size";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
} from "@t3tools/shared/imageDimensions";

import { MAX_COMPRESSIBLE_SOURCE_BYTES, prepareImageForAttachment } from "~/lib/imageCompression";
import { loadEditorImage } from "./imageEditorExport";

type ImageSize = { width: number; height: number };

async function inspectImage(file: File) {
  if (file.size > MAX_COMPRESSIBLE_SOURCE_BYTES)
    throw new Error(m(msg("Image editing supports source files up to 50 MB.")));
  const header = new Uint8Array(await file.slice(0, IMAGE_DIMENSIONS_HEADER_BYTES).arrayBuffer());
  const gif =
    file.type === "image/gif" || /^GIF8[79]a$/.test(new TextDecoder().decode(header.slice(0, 6)));
  let size = readImageDimensions(header);
  if (!size) {
    const url = URL.createObjectURL(file);
    try {
      const image = await loadEditorImage(url);
      size = { width: image.naturalWidth, height: image.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return { size, gif };
}

async function resizeImage(file: File, size: ImageSize) {
  const url = URL.createObjectURL(file);
  const canvas = document.createElement("canvas");
  try {
    const image = await loadEditorImage(url);
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(m(msg("Your browser could not prepare the image attachment.")));
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) =>
          value
            ? resolve(value)
            : reject(new Error(m(msg("The image attachment could not be resized.")))),
        "image/png",
      );
    });
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".png", {
      type: "image/png",
      lastModified: file.lastModified,
    });
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function prepareImageEditorAttachments(
  result: { files: ReadonlyArray<File>; sessionFile?: File | undefined },
  maxBytes = PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
) {
  const sources = [];
  for (const file of result.files) sources.push({ file, ...(await inspectImage(file)) });
  const prepared: Array<{ file: File; size: ImageSize }> = [];
  const prepare = async (file: File) => {
    const output = await prepareImageForAttachment(file, maxBytes);
    if (!output.ok)
      throw new Error(
        output.reason === "too-large"
          ? "This image could not fit the attachment size limit. Crop it or use a smaller image."
          : "This image could not be prepared for sending. Convert it to PNG or JPEG and try again.",
      );
    const { size } = await inspectImage(output.file);
    if (Math.max(size.width, size.height) > IMAGE_ATTACHMENT_MAX_EDGE)
      throw new Error(
        m(
          msg(
            "This image could not be resized for sending. Convert it to PNG or JPEG and try again.",
          ),
        ),
      );
    return { file: output.file, size };
  };
  for (const source of sources) {
    const edge = Math.max(source.size.width, source.size.height);
    if (source.gif) {
      if (edge > IMAGE_ATTACHMENT_MAX_EDGE || source.file.size > maxBytes)
        throw new Error(
          m(
            msg(
              "This GIF exceeds the attachment limits. Resize the animation before adding it to chat.",
            ),
          ),
        );
      prepared.push({ file: source.file, size: source.size });
      continue;
    }
    const scale = Math.min(1, IMAGE_ATTACHMENT_MAX_EDGE / edge);
    const file =
      scale < 1
        ? await resizeImage(source.file, {
            width: Math.max(1, Math.round(source.size.width * scale)),
            height: Math.max(1, Math.round(source.size.height * scale)),
          })
        : source.file;
    prepared.push(await prepare(file));
  }
  const sessionIndex = result.files.indexOf(result.sessionFile!);
  const frame = sources[sessionIndex]?.size;
  const aligned = frame
    ? sources.flatMap((source, index) =>
        !source.gif && source.size.width === frame.width && source.size.height === frame.height
          ? [index]
          : [],
      )
    : [];
  if (aligned.length > 1) {
    let size = {
      width: Math.min(...aligned.map((index) => prepared[index]!.size.width)),
      height: Math.min(...aligned.map((index) => prepared[index]!.size.height)),
    };
    // Byte compression can shrink one image further; keep its original, guidance and mask aligned.
    while (
      aligned.some(
        (index) =>
          prepared[index]!.size.width !== size.width ||
          prepared[index]!.size.height !== size.height,
      )
    ) {
      for (const index of aligned) {
        const current = prepared[index]!;
        if (current.size.width === size.width && current.size.height === size.height) continue;
        const next = await prepare(await resizeImage(current.file, size));
        prepared[index] = next;
        size = {
          width: Math.min(size.width, next.size.width),
          height: Math.min(size.height, next.size.height),
        };
      }
    }
  }
  return {
    files: prepared.map((output) => output.file),
    imageSizes: new Map(prepared.map((output) => [output.file, output.size])),
    ...(sessionIndex >= 0 ? { sessionFile: prepared[sessionIndex]!.file } : {}),
  };
}
