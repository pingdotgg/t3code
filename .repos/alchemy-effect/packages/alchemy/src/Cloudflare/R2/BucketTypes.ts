import type * as runtime from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface R2Object extends Omit<runtime.R2Object, "writeHttpMetadata"> {
  writeHttpMetadata(headers: Headers): Effect.Effect<void>;
}

export interface ObjectBody extends R2Object {
  get body(): Stream.Stream<Uint8Array, R2Error>;
  get bodyUsed(): boolean;
  arrayBuffer(): Effect.Effect<ArrayBuffer, R2Error>;
  bytes(): Effect.Effect<Uint8Array, R2Error>;
  text(): Effect.Effect<string, R2Error>;
  json<T>(): Effect.Effect<T, R2Error>;
  blob(): Effect.Effect<runtime.Blob, R2Error>;
}

export type GetOptions = runtime.R2GetOptions;
export type PutOptions = runtime.R2PutOptions & {
  contentLength?: number;
};

export type ListOptions = runtime.R2ListOptions;
export type Objects = {
  objects: R2Object[];
  delimitedPrefixes: string[];
} & (
  | {
      truncated: true;
      cursor: string;
    }
  | {
      truncated: false;
    }
);
export type Conditional = runtime.R2Conditional;

export class R2Error extends Data.TaggedError("R2Error")<{
  message: string;
  cause: Error;
}> {}

export interface MultipartUpload {
  raw: runtime.R2MultipartUpload;
  readonly key: string;
  readonly uploadId: string;
  uploadPart(
    partNumber: number,
    value: ReadableStream | (ArrayBuffer | ArrayBufferView) | string | Blob,
    options?: UploadPartOptions,
  ): Effect.Effect<UploadedPart, R2Error>;
  abort(): Effect.Effect<void, R2Error>;
  complete(uploadedParts: UploadedPart[]): Effect.Effect<R2Object, R2Error>;
}
export type MultipartOptions = runtime.R2MultipartOptions;
export type UploadedPart = runtime.R2UploadedPart;
export interface UploadPartOptions extends runtime.R2UploadPartOptions {}
