import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Parameter } from "./Parameter.ts";

export type ToolParameters<Refs> = {
  [toolName in Extract<Refs, Parameter>["~alchemy/Name"]]: Extract<
    Refs,
    Parameter
  >["schema"]["Type"];
};

export interface Tool<
  Name extends string = string,
  Refs extends any[] = any[],
> {
  "~alchemy/Kind": "Tool";
  "~alchemy/Name": Name;
  refs: Refs;
  template: TemplateStringsArray;
  params: {
    [p in keyof ToolParameters<Refs[number]>]: ToolParameters<Refs[number]>[p];
  };
  impl: (props: this["params"]) => Effect.Effect<any, any, any>;
  new (): Tool<Name, Refs>;
  <Err = never, Req = never>(
    impl: Effect.Effect<
      (props: this["params"]) => Effect.Effect<any>,
      Err,
      Req
    >,
  ): ToolImpl<this, Err, Req>;
  <Err = never, Req = never>(
    impl: (props: this["params"]) => Effect.Effect<any, Err, Req>,
  ): ToolImpl<this, Err, Req>;
}

export interface ToolImpl<
  T extends Tool<any, any> = any,
  Err = any,
  Req = any,
> {
  "~alchemy/Kind": "ToolImpl";
  tool: T;
  impl: (props: T["params"]) => Effect.Effect<any, Err, Req>;
  new (): {};
}

export const Tool: {
  <Name extends string>(
    name: Name,
  ): {
    <Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ): Tool<Name, Refs>;
  };
  <Self>(): {
    <Name extends string>(
      name: Name,
    ): {
      <Refs extends any[]>(
        template: TemplateStringsArray,
        ...refs: Refs
      ): Tool<Name, Refs> &
        Context.Service<
          Self,
          | ((
              input: ToolParameters<Refs[number]>,
            ) => Effect.Effect<any, never, RuntimeContext>)
          | Effect.Effect<
              (
                input: ToolParameters<Refs[number]>,
              ) => Effect.Effect<any, never, RuntimeContext>,
              never,
              RuntimeContext
            >
        >;
    };
  };
} = ((name?: string) =>
  name
    ? (template: TemplateStringsArray, ...refs: any[]) =>
        makeTool(name, template, refs)
    : (name: string) =>
        (template: TemplateStringsArray, ...refs: any[]) =>
          makeTool(name, template, refs)) as any;

const makeTool = (name: string, template: TemplateStringsArray, refs: any[]) =>
  Object.assign(
    function (impl: (props: any) => Effect.Effect<any, any, any>) {},
    {
      "~alchemy/Kind": "Tool",
      "~alchemy/Name": name,
      refs,
      template,
    },
  ) as any;
