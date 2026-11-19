// Files read from disk may load scripts, styles, fonts and images over https, but make no requests of
// their own (fetch, sockets, beacons, form posts) and frame no addresses.
// Never add a nonce or hash to script-src: it disables the 'unsafe-inline' pages rely on.
export const FILE_PAGE_NETWORK_POLICY = [
  "default-src 'none'",
  "script-src 'self' https: 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' https: 'unsafe-inline' data:",
  "img-src 'self' https: data: blob:",
  "font-src 'self' https: data:",
  "media-src 'self' data: blob:",
  "worker-src blob:",
  "connect-src data: blob:",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join("; ");
