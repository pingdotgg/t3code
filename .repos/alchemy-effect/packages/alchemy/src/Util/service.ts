import * as Context from "effect/Context";

export const GenericService =
  <
    Fn extends (T: { Type: string }) => Context.Service<any, any> = (
      ...args: any[]
    ) => Context.Service<any, any>,
  >() =>
  <Kind extends string>(Kind: Kind): ReturnType<Fn> & Fn => {
    // Tag key is a runtime `Kind`, so it can't be a class declaration.
    // oxlint-disable-next-line effecttsgo/service-not-as-class
    const service = Context.Service<any, any>(Kind);
    const make = (Type: string) => Context.Service(`${Kind}<${Type}>`);
    return Object.assign(Object.setPrototypeOf(make, service), service) as ReturnType<Fn> & Fn;
  };
