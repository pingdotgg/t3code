import { useEffect, useRef, useState, type ComponentProps, type SyntheticEvent } from "react";
import { isHeicImageFile } from "../../lib/imageCompression";

type AttachmentImageProps = ComponentProps<"img"> & { name: string; mimeType?: string | undefined };

// Keep import expressions outside hooks until React Compiler supports them.
const loadImageDecoder = () => import("../files/decodeImagePreview");

export function AttachmentImage({ name, mimeType, ...props }: AttachmentImageProps) {
  const fallback =
    isHeicImageFile({ name, type: mimeType ?? "" }) ||
    /\.tiff?$/i.test(name) ||
    /^image\/tiff$/i.test(mimeType ?? "");
  return fallback ? (
    <DecodedImage key={props.src} {...props} name={name} mimeType={mimeType} />
  ) : (
    <img {...props} />
  );
}

type DecodeAttempt = { readonly controller: AbortController; objectUrl?: string };

function DecodedImage({ name, mimeType, src, onError, ...props }: AttachmentImageProps) {
  const [previewUrl, setPreviewUrl] = useState<string>();
  // One decode per mount; the parent keys this component by src.
  const decodeRef = useRef<DecodeAttempt | null>(null);

  // The browser cannot show HEIC or TIFF itself, so its load error starts the decode.
  const decode = (event: SyntheticEvent<HTMLImageElement>) => {
    if (decodeRef.current !== null || !src) return onError?.(event);
    const attempt: DecodeAttempt = { controller: new AbortController() };
    decodeRef.current = attempt;
    const { signal } = attempt.controller;
    void loadImageDecoder()
      .then(async ({ decodeImagePreview }) => {
        if (signal.aborted) return;
        const blob = await decodeImagePreview(
          src,
          /\.hei[cf]$/i.test(name) || /^image\/hei[cf]$/i.test(mimeType ?? ""),
          signal,
        );
        if (signal.aborted) return;
        attempt.objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(attempt.objectUrl);
      })
      .catch(() => {
        if (!signal.aborted) onError?.(event);
      });
  };

  // oxlint-disable-next-line t3code/react-effect-budget -- the async decode and its blob URL live as long as this component
  useEffect(
    () => () => {
      const attempt = decodeRef.current;
      if (attempt === null) return;
      attempt.controller.abort();
      if (attempt.objectUrl) URL.revokeObjectURL(attempt.objectUrl);
    },
    [],
  );

  return <img {...props} src={previewUrl ?? src} onError={decode} />;
}
