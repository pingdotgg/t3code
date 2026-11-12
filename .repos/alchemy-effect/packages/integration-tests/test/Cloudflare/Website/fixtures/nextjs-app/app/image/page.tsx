/** @jsxImportSource react */
import Image from "next/image";

export const dynamic = "force-dynamic";

// next/image with `unoptimized`: serves the raw asset through the ASSETS
// binding. Real optimization requires a zone with Cloudflare Images —
// documented on the resource; on workers.dev this is the supported mode.
export default function ImagePage() {
  return (
    <main>
      <h1>IMAGE_PAGE_MARKER</h1>
      <Image src="/pixel.png" alt="pixel" width={1} height={1} unoptimized />
    </main>
  );
}
