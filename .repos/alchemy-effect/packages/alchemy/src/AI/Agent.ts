import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { effectClass } from "../Util/effect.ts";
import type { ToolImpl } from "./Tool.ts";

export type Services<Refs extends any[]> = Refs[number] extends infer A
  ? A extends
      | ToolImpl<infer _T, infer _Err, infer Req>
      | Context.Service<infer Req, infer _Shape>
    ? Req
    : never
  : never;

export interface Agent<
  Name extends string = string,
  Refs extends any[] = any[],
  Service = AgentService,
  Req = never,
> {
  [Symbol.iterator](): Effect.EffectIterator<
    Effect.Effect<Service, never, Req>
  >;
  "~alchemy/Kind": "Agent";
  name: Name;
  refs: Refs;
  req: Services<Refs>;
  new (): AgentService;
}

export interface AgentService {
  send(request: {
    input: any;
    session?: string;
  }): Effect.Effect<void, never, RuntimeContext>;
}

export const Agent: {
  <Self>(): {
    <Name extends string>(
      id: Name,
    ): {
      <const Refs extends any[]>(
        template: TemplateStringsArray,
        ...refs: Refs
      ): Agent<Name, Refs, Self, Services<Refs>>;
    };
  };
  <Name extends string>(
    id: Name,
  ): {
    <Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ): Agent<Name, Refs, AgentService, Services<Refs>>;
  };
} = ((name?: string) =>
  name
    ? (template: TemplateStringsArray, ...refs: any[]) =>
        makeAgent(name, template, refs)
    : (name: string) =>
        (template: TemplateStringsArray, ...refs: any[]) =>
          makeAgent(name, template, refs)) as any;

const makeAgent = (name: string, template: TemplateStringsArray, refs: any[]) =>
  Object.assign(
    effectClass(
      Effect.gen(function* () {
        // TODO(sam): implement the agent
      }),
    ),
    {
      "~alchemy/Kind": "Agent",
      "~alchemy/Name": name,
      refs,
      template,
    },
  ) as any;
