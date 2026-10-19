/**
 * Id source for picker annotations and their targets, one per page load.
 *
 * The composer keeps annotations keyed by id across preview reloads, and this
 * preload restarts on every page load, so a bare counter reissues ids that a
 * draft already holds. `getRandomValues` rather than `randomUUID`, because
 * plain-http previews (LAN, tailnet) are not secure contexts.
 */
export function createAnnotationIdSource(): (prefix: string) => string {
  const pageLoad = Array.from(crypto.getRandomValues(new Uint32Array(2)), (part) =>
    part.toString(36),
  ).join("");
  let sequence = 0;
  return (prefix) => {
    sequence += 1;
    return `${prefix}_${pageLoad}_${sequence.toString(36)}`;
  };
}
