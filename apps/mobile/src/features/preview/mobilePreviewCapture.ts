import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { File } from "expo-file-system";
import { Image, PixelRatio, Platform, type View } from "react-native";
import { captureRef, releaseCapture } from "react-native-view-shot";
import type { RefObject } from "react";

import { estimateBase64ByteSize } from "../../lib/base64";
import {
  MOBILE_PREVIEW_CAPTURE_MAX_ATTEMPTS,
  mobilePreviewCaptureLogicalSize,
  mobilePreviewScreenshotScale,
  type MobilePreviewCaptureLayout,
} from "./mobilePreviewCaptureModel";

export interface MobilePreviewCapturedPng {
  readonly mimeType: "image/png";
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

export async function captureMobilePreviewPng(input: {
  readonly viewRef: RefObject<View | null>;
  readonly layout: MobilePreviewCaptureLayout;
  readonly viewport: { readonly width: number; readonly height: number };
}): Promise<MobilePreviewCapturedPng> {
  if (!input.viewRef.current) {
    throw new Error("Browser is not ready to capture.");
  }
  for (let attempt = 0; attempt < MOBILE_PREVIEW_CAPTURE_MAX_ATTEMPTS; attempt += 1) {
    const targetSize = mobilePreviewCaptureLogicalSize({
      layout: input.layout,
      pixelRatio: PixelRatio.get(),
      attempt,
      platform: Platform.OS === "android" ? "android" : "ios",
    });
    const uri = await captureRef(input.viewRef, {
      format: "png",
      result: "tmpfile",
      ...targetSize,
    });
    try {
      const file = new File(uri);
      const reportedSize = file.size;
      if (
        reportedSize !== null &&
        (reportedSize <= 0 || reportedSize > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
      ) {
        continue;
      }
      const [{ width, height }, data] = await Promise.all([Image.getSize(uri), file.base64()]);
      const sizeBytes = reportedSize ?? estimateBase64ByteSize(data);
      if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        continue;
      }
      const scale = mobilePreviewScreenshotScale({
        imageWidth: width,
        imageHeight: height,
        viewportWidth: input.viewport.width,
        viewportHeight: input.viewport.height,
      });
      if (scale === null) {
        throw new Error("Browser changed size while it was being captured.");
      }
      return {
        mimeType: "image/png",
        data,
        width,
        height,
        scale,
      };
    } finally {
      releaseCapture(uri);
    }
  }
  throw new Error("The browser image exceeds the 10 MB attachment limit.");
}
