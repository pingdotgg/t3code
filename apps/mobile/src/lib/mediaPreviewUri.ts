/** Fallback URLs may already contain the authored fragment. */
export function mediaPreviewUri(uri: string | null, srcFragment?: string): string | null {
  if (uri === null || !srcFragment) return uri;
  return uri.split("#", 1)[0] + srcFragment;
}
