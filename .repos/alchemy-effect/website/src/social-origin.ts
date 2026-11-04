/**
 * Origin for absolute social-card URLs (`og:image`, `og:url`, `twitter:image`).
 *
 * Builds bake in the `site` config and the deployed worker rewrites those
 * URLs to each request's host (`rewriteSocialCardHost` in `worker.ts`). The
 * dev server has no worker in front of it, so in dev the origin comes from the
 * request URL instead, which lets `astro dev` behind a tunnel unfurl its own
 * cards. Prerendered pages get no request headers in dev, so the scheme can't
 * be read from `x-forwarded-proto`; tunnels terminate TLS, so any non-local
 * host is assumed to be served over https.
 */
export function socialOrigin(site: URL | undefined, url: URL): URL | undefined {
  if (!import.meta.env.DEV) return site;
  const local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|100\.)/.test(url.hostname);
  return new URL(`${local ? url.protocol : "https:"}//${url.host}`);
}
