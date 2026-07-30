import type { Input } from "../Input.ts";
import { type Output, isOutput } from "../Output.ts";
import type { IsAny } from "./types.ts";

// @ts-expect-error - we want to allow any value to be checked for unknown
export const isUnknown = <V>(value: V): value is Output<Input.Resolve<V>> =>
  isOutput(value);

export type IsUnknown<T> = unknown extends T
  ? IsAny<T> extends true
    ? false
    : true
  : false;

export type UnknownKeys<T> = {
  [K in keyof T]: IsUnknown<T[K]> extends true ? K : never;
}[keyof T];

export type ExcludeUnknown<T> = IsUnknown<T> extends true ? never : T;
