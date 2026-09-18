/** Transport-independent input and scoped, opaque push transactions. */
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Result from "effect/Result";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { ObjectType } from "./Protocol/ObjectCodec.ts";
import { StoreError } from "./Protocol/Store.ts";
import type {
  CommitPushResult,
  RefCommand,
  RepoMetaData,
} from "./RepoObject.ts";
import type { StreamingFeeder } from "./Store/StreamingSource.ts";

/** A proposed ref change. Zero old/new OIDs mean creation/deletion. */
export type RefUpdate = RefCommand;

/** Decoded commands and a streaming pack. Use the HTTP decoder or Push.fromStream to construct inputs. */
export interface PushInput {
  readonly updates: ReadonlyArray<RefUpdate>;
  readonly atomic: boolean;
}

/** @internal The decoder and engine share this state; applications see PushInput. */
export interface IncomingState {
  readonly feeder: StreamingFeeder;
  readonly receiving: Fiber.Fiber<
    Result.Result<{ readonly total: number }, StoreError>
  >;
  readonly packStart: number;
  readonly declaredBytes: number | undefined;
  active: boolean;
  claimed: boolean;
}

/** @internal */
export const incomingStates = new WeakMap<PushInput, IncomingState>();

/** A staged push, usable only within the scope that prepared it. */
export interface PreparedPush {
  readonly repo: RepoMetaData;
  readonly updates: ReadonlyArray<RefUpdate>;
  /** Read an incoming or existing object, bounded to 1 MiB by default. */
  readonly readObject: (
    oid: string,
    maxBytes?: number,
  ) => Effect.Effect<
    { readonly type: ObjectType; readonly content: Uint8Array } | undefined,
    StoreError,
    RuntimeContext
  >;
}

/** @internal */
export const preparedStates = new WeakMap<
  PreparedPush,
  {
    readonly owner: object;
    readonly commit: Effect.Effect<
      CommitPushResult,
      StoreError,
      RuntimeContext
    >;
  }
>();

/** A transaction/input was already consumed, escaped its scope, or belongs to another engine. */
export const invalidPush = () =>
  new StoreError({
    reason: "push is no longer active or belongs to another engine",
  });
