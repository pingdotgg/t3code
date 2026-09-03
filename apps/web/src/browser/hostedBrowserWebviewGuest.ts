/**
 * Electron treats `partition` and `src` as constructor inputs. Changing `src`
 * after attach triggers navigation. Key the element by partition so a project
 * change remounts. Latch `src` to that key so later React renders cannot
 * rewrite it.
 */
export function hostedBrowserWebviewKey(partition: string, generation: number): string {
  return `${partition}:${generation}`;
}

export function latchHostedBrowserWebviewSrc(
  latched: { readonly key: string; readonly src: string } | null,
  key: string,
  src: string,
): { readonly key: string; readonly src: string } {
  return latched?.key === key ? latched : { key, src };
}
