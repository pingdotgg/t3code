/** Per-load nonces avoid draft ID collisions; getRandomValues works on plain HTTP. */
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
