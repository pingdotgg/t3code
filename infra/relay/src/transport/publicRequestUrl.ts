export function relayPublicRequestUrl(input: {
  readonly url: string;
  readonly source: unknown;
  readonly forwardedUrl?: string;
}): string {
  if (input.forwardedUrl !== undefined) return input.forwardedUrl;
  return input.source instanceof Request ? input.source.url : input.url;
}
