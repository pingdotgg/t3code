export const bunWebSocketOptions = {
  // Negotiate permessage-deflate with clients that offer it; clients that
  // don't still get uncompressed frames on their connection. A dedicated
  // compressor keeps a per-connection sliding window (context takeover) so the
  // compression dictionary is shared across server-to-client frames.
  // Decompression uses the shared decompressor: uWebSockets' dedicated
  // decompressor path can abort connections (close 1006) on valid DEFLATE
  // input — see https://github.com/uNetworking/uWebSockets.js/issues/633.
  perMessageDeflate: {
    compress: "dedicated",
    decompress: "shared",
  },
  // RPC clients ping every 5s. Reaping a connection after six missed ping
  // windows releases suspended-mobile sockets well before Bun's 120s default.
  idleTimeout: 30,
} as const;
