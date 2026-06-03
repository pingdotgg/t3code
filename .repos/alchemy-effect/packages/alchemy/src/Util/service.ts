import * as Context from "effect/Context";

export const GenericService =
  <
    Fn extends (T: { Type: string }) => Context.Service<any, any> = (
      ...args: any[]
    ) => Context.Service<any, any>,
  >() =>
  <Kind extends string>(Kind: Kind): ReturnType<Fn> & Fn => {
    const service = Context.Service<any, any>(Kind);
    const make = (Type: string) => Context.Service(`${Kind}<${Type}>`);
    return Object.assign(
      Object.setPrototypeOf(make, service),
      service,
    ) as ReturnType<Fn> & Fn;
  };
