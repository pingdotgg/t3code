/** The stream surface both `net.Socket` and hyperdht's Noise streams satisfy. */
export interface RelayStream extends NodeJS.ReadWriteStream {
  readonly destroyed: boolean;
  destroy(error?: Error): void;
}

/**
 * Bridges the two halves of a tunnel hop: pipes each stream into the other
 * and destroys both as soon as either side errors or closes, so a dead peer
 * never leaves a half-open socket behind (the hypertele teardown pattern).
 */
export const relayStreams = (a: RelayStream, b: RelayStream): void => {
  const closeBoth = () => {
    if (!a.destroyed) {
      a.destroy();
    }
    if (!b.destroyed) {
      b.destroy();
    }
  };
  a.on("error", closeBoth);
  b.on("error", closeBoth);
  a.on("close", closeBoth);
  b.on("close", closeBoth);
  a.pipe(b);
  b.pipe(a);
};
