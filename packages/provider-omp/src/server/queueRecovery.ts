import {
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { array, record, string } from "./rpc.ts";

export function readOmpQueueRecovery(value: unknown) {
  const reply = record(value);
  const nativeEntries = [...array(reply.steering), ...array(reply.followUp)];
  let imagesDropped = reply.imagesDropped === true;
  let remainingImages = PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
  let remainingBytes = PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;
  let remainingText = 128_000;
  const entries = [];
  for (const [index, item] of nativeEntries.entries()) {
    const native = record(item);
    const text = string(native.text) ?? "";
    if (entries.length >= 128 || text.length > remainingText) {
      return { entries, imagesDropped, truncated: true };
    }
    remainingText -= text.length;
    const images = array(native.images).flatMap((item, imageIndex) => {
      const image = record(item);
      const mimeType = string(image.mimeType)?.toLowerCase();
      const data = string(image.data);
      if (
        !mimeType ||
        !isProviderSendTurnSupportedImageMimeType(mimeType) ||
        !data ||
        remainingImages === 0 ||
        data.length > Math.ceil(remainingBytes / 3) * 4
      ) {
        imagesDropped = true;
        return [];
      }
      const bytes = Buffer.from(data, "base64");
      if (
        bytes.length === 0 ||
        bytes.length > remainingBytes ||
        bytes.toString("base64") !== data
      ) {
        imagesDropped = true;
        return [];
      }
      remainingImages--;
      remainingBytes -= bytes.length;
      const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice(6);
      return [{ mimeType, bytes, name: `omp-${index + 1}-${imageIndex + 1}.${extension}` }];
    });
    if (text || images.length > 0) entries.push({ text, images });
  }
  return { entries, imagesDropped, truncated: reply.truncated === true };
}
