import * as SchemaAST from "effect/SchemaAST";
import { none, type Many } from "stream-chain/defs.js";
import { Assembler } from "stream-json/core/assembler.js";
import * as StreamJson from "stream-json/core/parser.js";
import type { ParserOptions, Token } from "stream-json/core/parser.js";

type JsonPath = ReadonlyArray<string | number | null>;

export function createTranscriptJsonSelector(schema: { readonly ast: SchemaAST.AST }) {
  const ast = SchemaAST.toEncoded(schema.ast);
  const includes = (node: SchemaAST.AST, path: JsonPath, index: number): boolean => {
    if (index === path.length) return true;
    switch (node._tag) {
      case "Objects":
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
        return true;
      default:
        return false;
    }
  };
  return (path: JsonPath) => includes(ast, path, 0);
}

export class TranscriptJsonLimitError extends Error {}

export function createTranscriptJsonReader(
  reserve: (bytes: number) => void,
  selectPath: (path: JsonPath) => boolean,
  options?: { readonly maxDepth?: number },
) {
  // 3.6.0 omits the synchronous tokenizer from types; parser() adds an unnecessary async generator.
  const { jsonParser } = StreamJson as typeof StreamJson & {
    jsonParser: (
      options: ParserOptions,
    ) => (input: string | typeof none) => Many<Token> | typeof none;
  };
  const tokenize = jsonParser({ packValues: false });
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
  // Preserve actual keys; adjacent duplicates share a path, but JSON.parse keeps the last value.
  const stack: Array<{ path: JsonPath; key: string | number | null; selected: boolean }> = [];
  let selectedValue = false;
  const startValue = () => {
    const parent = stack.at(-1);
    const path = parent?.selected ? [...parent.path, parent.key] : [];
    const selected = (parent?.selected ?? true) && selectPath(path);
    if (selected && typeof parent?.key === "string") {
      assemble({ name: "keyValue", value: parent.key });
    }
    return { path, selected };
  };
  const endValue = () => {
    const parent = stack.at(-1);
    if (parent && typeof parent.key === "number") parent.key++;
  };
  const selectToken = (token: Token | typeof none) => {
    if (token === none) return;
    switch (token.name) {
      case "keyValue": {
        const parent = stack.at(-1);
        if (parent) parent.key = token.value;
        return;
      }
      case "startObject":
      case "startArray": {
        const frame = startValue();
        stack.push({ ...frame, key: token.name === "startArray" ? 0 : null });
        if (frame.selected) assemble(token);
        return;
      }
      case "endObject":
      case "endArray":
        if (stack.pop()?.selected) assemble(token);
        endValue();
        return;
      case "startString":
      case "startNumber":
        selectedValue = startValue().selected;
        if (selectedValue) assemble(token);
        return;
      case "endString":
      case "endNumber":
        if (selectedValue) assemble(token);
        endValue();
        return;
      case "nullValue":
      case "trueValue":
      case "falseValue":
        if (startValue().selected) assemble(token);
        endValue();
        return;
      default:
        if (selectedValue) assemble(token);
    }
  };
  const consume = (input: string | typeof none) => {
    if (malformed) return;
    try {
      const tokens = tokenize(input);
      if (tokens === none) return;
      for (const token of tokens.values) {
        if (token.name === "startObject" || token.name === "startArray") {
          if (++depth > (options?.maxDepth ?? 128))
            throw new TranscriptJsonLimitError("Transcript JSON nesting exceeds the depth limit");
        } else if (token.name === "endObject" || token.name === "endArray") {
          if (--depth === 0) complete = true;
        }
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
