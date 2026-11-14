"use client";

// Vinext inlines `NEXT_PUBLIC_*` into the client bundle at build time.
export default function PublicEnvPage() {
  return <p>{process.env.NEXT_PUBLIC_SITE_MARKER}</p>;
}
