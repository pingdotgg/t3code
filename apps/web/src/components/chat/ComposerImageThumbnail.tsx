import { memo, useEffect, useState, type ReactNode } from "react";

import {
  createComposerImageThumbnail,
  type ComposerImageThumbnailMode,
} from "../../lib/imageCompression";
import { cn } from "../../lib/utils";

/** Keep full-resolution image decoding out of composer rerenders. */
export const ComposerImageThumbnail = memo(function ComposerImageThumbnail({
  file,
  mode = "square",
  alt,
  className,
  fallback,
}: {
  file: File;
  mode?: ComposerImageThumbnailMode;
  alt: string;
  className: string;
  fallback: ReactNode;
}) {
  const [preview, setPreview] = useState<{
    file: File;
    mode: ComposerImageThumbnailMode;
    src: string | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void createComposerImageThumbnail(file, mode).then((src) => {
      if (active) setPreview({ file, mode, src });
    });
    return () => {
      active = false;
    };
  }, [file, mode]);
  const src = preview?.file === file && preview.mode === mode ? preview.src : null;
  return src ? (
    <img
      src={src}
      alt={alt}
      className={cn(className, mode === "snapshot" ? "object-contain" : "object-cover")}
    />
  ) : (
    fallback
  );
});
