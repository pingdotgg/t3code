/** @jsxImportSource react */
"use client";

// Waku inlines `WAKU_PUBLIC_*` into the client bundle at build time.
export function PublicEnv() {
  return <p data-testid="public-env">{import.meta.env.WAKU_PUBLIC_SITE_MARKER}</p>;
}
