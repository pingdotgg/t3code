import * as Output from "./Output.ts";
import type { ResourceLike } from "./Resource.ts";

// special runtime-only symbol for probing the Ref proxy for its metadata
const RefMetadata = Symbol.for("alchemy/RefMetadata");

export const isRef = (s: any): s is Ref<any> =>
  s && s[RefMetadata] !== undefined;

export const getRefMetadata = <R extends ResourceLike>(
  ref: Ref<R>,
): RefMetadata<R> => (ref as any)[RefMetadata];

export interface Ref<R extends ResourceLike = ResourceLike> {
  /** @internal phantom */
  Ref: R;
}

export interface RefMetadata<R extends ResourceLike> {
  id: R["LogicalId"];
  stack?: string;
  stage?: string;
}

export const ref = <R extends ResourceLike>(
  id: string,
  {
    stack,
    stage,
  }: {
    stack?: string;
    stage?: string;
  } = {},
): Ref<R> => {
  const ref = new Proxy(
    {},
    {
      get: (_, prop) => {
        if (prop === RefMetadata) {
          return {
            stack,
            stage,
            id,
          } satisfies RefMetadata<R>;
        }
        return (Output.of(ref) as any)[prop];
      },
    },
  ) as Ref<R>;
  return ref;
};
