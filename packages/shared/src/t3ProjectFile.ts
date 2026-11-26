import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { T3ProjectFile } from "@t3tools/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const T3ProjectFileFromJson = fromLenientJson(T3ProjectFile);

const decodeT3ProjectFile = Schema.decodeExit(T3ProjectFileFromJson);

export function parseT3ProjectFile(contents: string): T3ProjectFile | null {
  const decoded = decodeT3ProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}
