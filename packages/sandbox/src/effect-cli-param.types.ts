declare module "effect/unstable/cli/Param" {
  export const variadic: {
    <Kind extends import("effect/unstable/cli/Param").ParamKind, A>(
      self: import("effect/unstable/cli/Param").Param<Kind, A>,
      options?: import("effect/unstable/cli/Param").VariadicParamOptions | undefined,
    ): import("effect/unstable/cli/Param").Param<Kind, ReadonlyArray<A>>;
  };
}

export {};
