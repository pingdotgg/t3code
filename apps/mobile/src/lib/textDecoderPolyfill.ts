type TextDecoderConstructor = typeof TextDecoder;

// Hermes' TextDecoder only knows UTF-8 and UTF-16, so file previews could not fall back to
// GBK / GB18030. Labels the native decoder rejects go to a spec-complete JS decoder instead.
export function withLegacyEncodings(
  NativeTextDecoder: TextDecoderConstructor,
  loadSpecTextDecoder: () => TextDecoderConstructor,
): TextDecoderConstructor {
  try {
    if (new NativeTextDecoder("gb18030").encoding === "gb18030") return NativeTextDecoder;
  } catch {}
  return function TextDecoder(label?: string, options?: TextDecoderOptions) {
    try {
      return new NativeTextDecoder(label, options);
    } catch {
      return new (loadSpecTextDecoder())(label, options);
    }
  } as unknown as TextDecoderConstructor;
}

globalThis.TextDecoder = withLegacyEncodings(
  globalThis.TextDecoder,
  // Required lazily: its encoding tables are only needed once a legacy-encoded file is opened,
  // and its type declarations pull in @types/node, which conflicts with React Native's globals.
  () => require("@exodus/bytes/encoding.js").TextDecoder,
);
