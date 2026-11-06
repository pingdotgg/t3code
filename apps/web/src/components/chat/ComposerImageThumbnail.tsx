import { memo, useLayoutEffect, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import {
  createComposerImageThumbnail,
  isHeicImageFile,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
  readComposerImageThumbnail,
} from "../../lib/imageCompression";

export const ComposerImageThumbnail = memo(function ComposerImageThumbnail({
  file,
  alt,
  className,
  fallback,
}: {
  file: File;
  alt: string;
  className: string;
  fallback: ReactNode;
}) {
  const [preview, setPreview] = useState(() => ({
    file,
    src: readComposerImageThumbnail(file),
  }));
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = preview.file === file ? preview.src : readComposerImageThumbnail(file);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the local blob URL and decodes its replacement before swapping the visible image
  useLayoutEffect(() => {
    let disposed = false;
    let localUrl: string | undefined;
    const cached = readComposerImageThumbnail(file);
    if (
      file.size <= MAX_COMPRESSIBLE_SOURCE_BYTES &&
      !isHeicImageFile(file) &&
      cached === undefined
    ) {
      localUrl = URL.createObjectURL(file);
      // oxlint-disable-next-line react/set-state-in-effect -- the blob URL is created and revoked by this effect
      setPreview({ file, src: localUrl });
    }
    if (cached === undefined) {
      void createComposerImageThumbnail(file).then(async (thumbnail) => {
        if (disposed) return;
        if (!thumbnail) {
          if (!localUrl) setPreview({ file, src: null });
          return;
        }
        const image = new Image();
        image.src = thumbnail;
        try {
          await image.decode();
          if (!disposed) setPreview({ file, src: thumbnail });
        } catch {
          // Keep the local preview if the thumbnail cannot be decoded.
        }
      });
    }
    return () => {
      disposed = true;
      if (localUrl) URL.revokeObjectURL(localUrl);
    };
  }, [file]);

  return src && failedSrc !== src ? (
    <img
      ref={(image) => {
        if (image?.complete && image.naturalWidth > 0) setLoadedSrc(src);
      }}
      src={src}
      alt={alt}
      onLoad={() => setLoadedSrc(src)}
      onError={() => setFailedSrc(src)}
      className={cn(className, loadedSrc !== src && "invisible")}
    />
  ) : src === undefined ? null : (
    fallback
  );
});
