import type * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import type { Data, Fields } from "./Event.ts";
import type * as Telemetry from "./Telemetry.ts";

/**
 * Instance type of a Rejection class: its `_tag` plus its evidence data.
 */
export type Instance<Tag extends string, F extends Fields> = { readonly _tag: Tag } & Data<F>;

/**
 * What a command or read can declare in `rejects`: any tagged error schema
 * class, such as a `Domain.Rejection`, a `Schema.TaggedError`, or one of
 * Effect's `HttpApiError` classes.
 */
export interface Any extends Schema.Top {
  new (...args: any[]): { readonly _tag: string };
}

/**
 * What a Rejection takes after its fields: every annotation
 * `Schema.TaggedError` takes (`description`, `httpApiStatus`, ...), plus the
 * span `attributes` it records.
 */
export type Annotations<Tag extends string, F extends Fields> = Schema.Annotations.Declaration<
  Instance<Tag, F>,
  readonly [Schema.TaggedStruct<Tag, F>]
> & {
  /**
   * Span attributes to record for this rejection, on every span it passes
   * through. Nothing from it is recorded unless you return it here, and a
   * `Redacted` value is recorded as `<redacted>`.
   */
  readonly attributes?: Telemetry.Attributes<Instance<Tag, F>>;
};

/**
 * A typed reason a command or read was refused. Nothing is recorded when a
 * command is rejected, and the caller receives the rejection exactly as
 * declared, through an Api too.
 *
 * It is `Schema.TaggedError` with its own type filled in, and takes the same
 * annotations. Any other tagged error class works in `rejects` as well.
 *
 * ### Declaring rejections
 * **Example:** A rejection with and without data
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Schema from "effect/Schema";
 *
 * export class NotOpen extends Domain.Rejection("NotOpen") {}
 *
 * export class InsufficientFunds extends Domain.Rejection("InsufficientFunds", {
 *   balance: Schema.Int,
 *   requested: Schema.Int,
 * }) {}
 * ```
 *
 * ### Annotating rejections
 * The third argument takes the annotations of `Schema.TaggedError`. An HTTP
 * API reads `httpApiStatus` from it, as it does for any Effect error.
 *
 * **Example:** A status and a description
 * ```typescript
 * export class NotOwner extends Domain.Rejection(
 *   "NotOwner",
 *   {},
 *   { httpApiStatus: 403, description: "Only the account's owner may do this." },
 * ) {}
 * ```
 *
 * @primitive
 */
export const make = <const Tag extends string, const F extends Fields = {}>(
  tag: Tag,
  fields: F = {} as F,
  annotations: Annotations<Tag, F> = {},
): RejectionClass<Tag, F> => {
  const { attributes, ...schemaAnnotations } = annotations;
  // The base type is conditional on `Self`, so it is not a constructor until `make` returns.
  const Base: new (...args: any[]) => object = Schema.TaggedError<Instance<Tag, F>>(tag)(
    tag,
    fields,
    schemaAnnotations,
  ) as any;
  return class extends Base {
    static readonly kind = "Rejection" as const;
    static readonly tag: Tag = tag;
    static readonly attributes = attributes;
  } as unknown as RejectionClass<Tag, F>;
};

/**
 * The class type returned by {@link make}.
 */
export interface RejectionClass<Tag extends string, F extends Fields> extends Schema.Class<
  Instance<Tag, F>,
  Schema.TaggedStruct<Tag, F>,
  Cause.YieldableError
> {
  readonly kind: "Rejection";
  readonly tag: Tag;
  /** Span attributes the rejection adds, if it declares any. */
  readonly attributes: Telemetry.Attributes<Instance<Tag, F>> | undefined;
}
