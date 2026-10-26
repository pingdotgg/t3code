import { memo, Suspense, use, type ReactNode } from "react";

import {
  createComposerImageThumbnail,
  readComposerImageThumbnail,
} from "../../lib/imageCompression";

export const ComposerImageThumbnail = memo(function ComposerImageThumbnail(props: {
  file: File;
  alt: string;
  className: string;
  fallback: ReactNode;
}) {
  return (
    <Suspense fallback={props.fallback}>
      <ThumbnailImage {...props} />
    </Suspense>
  );
});

function ThumbnailImage({
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
  // A settled thumbnail paints synchronously instead of suspending for a tick.
  const settled = readComposerImageThumbnail(file);
  const src = settled === undefined ? use(createComposerImageThumbnail(file)) : settled;
  return src ? <img src={src} alt={alt} className={className} /> : fallback;
}
