import { memo, useEffect, useState, type ReactNode } from "react";

import { createComposerImageThumbnail } from "../../lib/imageCompression";

/** Keep full-resolution image decoding out of composer rerenders. */
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
  const [preview, setPreview] = useState<{ file: File; src: string | null } | null>(null);
  useEffect(() => {
    let active = true;
    void createComposerImageThumbnail(file).then((src) => {
      if (active) setPreview({ file, src });
    });
    return () => {
      active = false;
    };
  }, [file]);
  const src = preview?.file === file ? preview.src : null;
  return src ? <img src={src} alt={alt} className={className} /> : fallback;
});
