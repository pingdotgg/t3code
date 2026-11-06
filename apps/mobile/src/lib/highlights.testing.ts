import { createHighlighter } from "@pierre/highlights";

// The highlighter's line-record API, which `Highlighter` does not declare.
interface LineRecordHighlighter {
  writeInput(input: string): number;
  tokenizeLineRecords(language: number, byteLength: number): Uint32Array;
}

/**
 * Stands in for the T3Highlights hybrid object with the WebAssembly build it is
 * compiled from. Return it from a mocked `NitroModules.createHybridObject`.
 */
export function createWasmHighlightsModule() {
  const highlighter = createHighlighter() as unknown as LineRecordHighlighter;
  return {
    tokenize(source: string, language: number): ArrayBuffer {
      const records = highlighter.tokenizeLineRecords(language, highlighter.writeInput(source));
      // The view points into WebAssembly memory that the next call reuses.
      return records.slice().buffer;
    },
  };
}
