import { type Data, type List, Message, type Struct } from "capnp-es";
import { type Config, kVoid } from "../Config.ts";
import { Config as CapnpConfig } from "./config.capnp.ts";

function capitalize<S extends string>(str: S): Capitalize<S> {
  return (str[0] ? str[0].toUpperCase() + str.substring(1) : str) as Capitalize<S>;
}

// Dynamically encode a capnp struct based on keys and the types of values.
// `obj` should be an instance of a type in `./workerd.ts`. The safety of
// this function relies on getting `./workerd.ts` correct, TypeScript's type
// safety guarantees, and us validating all user input with zod.
//
// TODO: generate `./workerd.ts` and corresponding encoders automatically
//  from the `.capnp` file.
function encodeCapnpStruct(obj: any, struct: Struct, path: ReadonlyArray<string> = []) {
  const anyStruct = struct as any;
  for (const [key, value] of Object.entries(obj)) {
    const capitalized = capitalize(key);
    const safeKey = key === "constructor" ? `$${key}` : key;
    const childPath = [...path, key];

    const callInit = (...args: Array<unknown>) => {
      const init = anyStruct[`_init${capitalized}`];
      if (typeof init !== "function") {
        const structName = anyStruct?.constructor?.name ?? "<unknown struct>";
        throw new TypeError(
          `serializeConfig: no setter \`_init${capitalized}\` on capnp struct \`${structName}\` for key \`${childPath.join(".")}\` (value type: ${describeValue(value)}). This usually means the config object contains a key that does not match the capnp schema. Value preview: ${previewValue(value)}`,
        );
      }
      return init.call(anyStruct, ...args);
    };

    if (value instanceof Uint8Array) {
      const newData: Data = callInit(value.byteLength);
      newData.copyBuffer(value);
    } else if (Array.isArray(value)) {
      const newList: List<any> = callInit(value.length);
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === "object") {
          encodeCapnpStruct(value[i], newList.get(i), [...childPath, String(i)]);
        } else {
          newList.set(i, value[i]);
        }
      }
    } else if (typeof value === "object" && value !== null) {
      const newStruct: Struct = callInit();
      encodeCapnpStruct(value, newStruct, childPath);
    } else if (value === kVoid) {
      assertHasKey(anyStruct, safeKey, childPath);
      anyStruct[safeKey] = undefined;
    } else if (value !== undefined) {
      // Ignore all `undefined` values, explicitly `undefined` values should use
      // kVoid symbol instead.
      assertHasKey(anyStruct, safeKey, childPath);
      anyStruct[safeKey] = value;
    }
  }
}

function assertHasKey(struct: any, key: string, path: ReadonlyArray<string>) {
  if (!(key in struct)) {
    const structName = struct?.constructor?.name ?? "<unknown struct>";
    throw new TypeError(
      `serializeConfig: no field \`${key}\` on capnp struct \`${structName}\` for path \`${path.join(".")}\`.`,
    );
  }
}

function previewValue(value: unknown): string {
  try {
    const json = JSON.stringify(value, (_key, v) =>
      v instanceof Uint8Array
        ? `<Uint8Array length=${v.byteLength}>`
        : typeof v === "string" && v.length > 120
          ? `${v.slice(0, 117)}...`
          : v,
    );
    return json && json.length > 500 ? `${json.slice(0, 497)}...` : (json ?? String(value));
  } catch {
    return String(value);
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Uint8Array) return "Uint8Array";
  return typeof value;
}

export function serializeConfig(config: Config): ArrayBuffer {
  const message = new Message();
  const struct = message.initRoot(CapnpConfig);
  encodeCapnpStruct(config, struct);
  return message.toArrayBuffer();
}
