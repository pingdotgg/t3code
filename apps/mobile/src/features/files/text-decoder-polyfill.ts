// Hermes's TextDecoder rejects legacy labels such as GB18030, so GBK source files could not be previewed.
// Native decoders stay in use; only labels Hermes rejects fall back to a WHATWG-complete decoder.
import { TextDecoder as SpecTextDecoder } from "@exodus/bytes/encoding.js";

globalThis.TextDecoder = new Proxy(globalThis.TextDecoder, {
  construct(NativeTextDecoder, args: ConstructorParameters<typeof TextDecoder>) {
    try {
      return new NativeTextDecoder(...args);
    } catch (nativeError) {
      try {
        return new SpecTextDecoder(...args);
      } catch {
        throw nativeError;
      }
    }
  },
});
