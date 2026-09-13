import * as SchemaAST from "effect/SchemaAST";
import { isMany, none, type Many } from "stream-chain/defs.js";
import { Assembler } from "stream-json/core/assembler.js";
import { filter } from "stream-json/core/filters/filter.js";
import * as StreamJson from "stream-json/core/parser.js";
import type { ParserOptions, Token } from "stream-json/core/parser.js";

type JsonPath = ReadonlyArray<string | number | null>;

/** Select schema fields before assembling their values, without a second field list. */
export function createTranscriptJsonSelector(schema: { readonly ast: SchemaAST.AST }) {
  const ast = SchemaAST.toEncoded(schema.ast);
  const includes = (node: SchemaAST.AST, path: JsonPath, index: number): boolean => {
    if (index === path.length) return true;
    switch (node._tag) {
      case "Objects":
        // Records have dynamic keys. Keep their values for the decoder to validate.
        if (node.indexSignatures.length > 0) return true;
        return node.propertySignatures.some(
          (property) =>
            String(property.name) === path[index] && includes(property.type, path, index + 1),
        );
      case "Arrays": {
        const key = path[index];
        if (typeof key !== "number") return true;
        const element = node.elements[key];
        if (element) return includes(element, path, index + 1);
        return node.rest.length === 0 || node.rest.some((item) => includes(item, path, index + 1));
      }
      case "Union":
        return node.types.some((type) => includes(type, path, index));
      case "Suspend":
        return includes(node.thunk(), path, index);
      case "Unknown":
      case "Any":
      case "ObjectKeyword":
      case "Declaration":
        // Unstructured/custom schemas must reach the decoder intact. The
        // shared budget still bounds their allocations.
        return true;
      default:
        return false;
    }
  };
  return (path: JsonPath) => includes(ast, path, 0);
}

export class TranscriptJsonLimitError extends Error {}

/**
 * Project a single JSONL record without materializing unselected string values.
 * The caller supplies a shared allocation budget for the entire transcript.
 * Budget exhaustion rejects the transcript, never a message within it.
 */
export function createTranscriptJsonReader(
  reserve: (bytes: number) => void,
  selectPath: (path: JsonPath) => boolean,
) {
  // The synchronous tokenizer is exported at runtime in 3.6.0, but omitted
  // from its bundled types. Unlike parser(), it does not wrap tokens in an
  // async generator; the file reader already supplies backpressure and UTF-8.
  const { jsonParser } = StreamJson as typeof StreamJson & {
    jsonParser: (
      options: ParserOptions,
    ) => (input: string | typeof none) => Many<Token> | typeof none;
  };
  const tokenize = jsonParser({ packValues: false });
  const select = filter({ filter: selectPath, streamKeys: false }) as (
    input: Token | typeof none,
  ) => Token | Many<Token> | typeof none;
  const assembler = new Assembler();
  let key: string | null = null;
  let value = "";
  let depth = 0;
  let complete = false;
  let malformed = false;

  const assemble = (token: Token) => {
    reserve(
      64 + ("value" in token && typeof token.value === "string" ? token.value.length * 2 : 0),
    );
    switch (token.name) {
      case "startString":
      case "startNumber":
        value = "";
        break;
      case "stringChunk":
      case "numberChunk":
        value += token.value;
        break;
      case "endString":
        assembler.consume({ name: "stringValue", value });
        value = "";
        break;
      case "endNumber":
        assembler.consume({ name: "numberValue", value });
        value = "";
        break;
      default:
        assembler.consume(token);
    }
  };
  const selectToken = (token: Token | typeof none) => {
    const selected = select(token);
    if (selected === none) return;
    if (isMany(selected)) {
      for (const item of selected.values) assemble(item);
    } else {
      assemble(selected);
    }
  };
  const consume = (input: string | typeof none) => {
    if (malformed) return;
    try {
      const tokens = tokenize(input);
      if (tokens === none) return;
      for (const token of tokens.values) {
        if (token.name === "startObject" || token.name === "startArray") {
          if (++depth > 128)
            throw new TranscriptJsonLimitError("Transcript JSON nesting exceeds 128 levels");
        } else if (token.name === "endObject" || token.name === "endArray") {
          if (--depth === 0) complete = true;
        }
        // Charge keys before assembling them, including unknown names. Reject
        // the transcript on exhaustion instead of silently shortening a key.
        if (token.name === "startKey") {
          key = "";
        } else if (token.name === "stringChunk" && key !== null) {
          reserve(token.value.length * 2);
          key += token.value;
        } else if (token.name === "endKey") {
          selectToken({ name: "keyValue", value: key ?? "" });
          key = null;
        } else {
          selectToken(token);
        }
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith("Parser ")) {
        malformed = true;
      } else {
        throw cause;
      }
    }
  };
  return {
    write: (chunk: string) => consume(chunk),
    finish: (): unknown => {
      consume(none);
      if (malformed || !complete) return undefined;
      selectToken(none);
      return assembler.done ? assembler.current : undefined;
    },
  };
}
