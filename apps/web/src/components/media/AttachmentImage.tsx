import {
  useEffect,
  useEffectEvent,
  useState,
  type ComponentProps,
  type SyntheticEvent,
} from "react";
import {
  isHeicImageFile,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
  prepareImageForAttachment,
} from "../../lib/imageCompression";

type AttachmentImageProps = ComponentProps<"img"> & { name: string; mimeType?: string | undefined };

export function AttachmentImage({ name, mimeType, ...props }: AttachmentImageProps) {
  return isHeicImageFile({ name, type: mimeType ?? "" }) ? (
    <HeicImage key={props.src} {...props} name={name} />
  ) : (
    <img {...props} />
  );
}

function HeicImage({ name, src, onError, ...props }: Omit<AttachmentImageProps, "mimeType">) {
  const [decodeError, setDecodeError] = useState<SyntheticEvent<HTMLImageElement> | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>();

  const reportError = useEffectEvent((event: SyntheticEvent<HTMLImageElement>) => onError?.(event));

  useEffect(() => {
    if (!decodeError || !src) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    const decode = async () => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) return reportError(decodeError);
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        const result = await prepareImageForAttachment(
          new File([blob], name, { type: "image/heic" }),
          MAX_COMPRESSIBLE_SOURCE_BYTES,
        );
        if (controller.signal.aborted) return;
        if (!result.ok) return reportError(decodeError);
        objectUrl = URL.createObjectURL(result.file);
        setPreviewUrl(objectUrl);
      } catch {
        if (!controller.signal.aborted) reportError(decodeError);
      }
    };
    void decode();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [decodeError, name, src]);

  return (
    <img {...props} src={previewUrl ?? src} onError={decodeError ? onError : setDecodeError} />
  );
}
