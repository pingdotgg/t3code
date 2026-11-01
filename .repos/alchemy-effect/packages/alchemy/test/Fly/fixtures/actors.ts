import type { ScratchStack } from "@/Test/Alchemy";
import { scratchStack } from "@/Test/Core";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { throughProxy } from "./transport.ts";

/** Fresh engine/provider/state layers address the same durable test.provider rows. */
export const engineActor = (
  parent: ScratchStack,
  title: string,
  file: string,
  endpoint?: string,
) =>
  Effect.sync(() => {
    const actor = scratchStack(
      {
        providers: throughProxy(() => endpoint),
        stage: parent.stage,
      },
      title,
      file,
    );
    expect(actor.name).toBe(parent.name);
    expect(actor.stage).toBe(parent.stage);
    expect(actor.state).not.toBe(parent.state);
    return actor;
  });
