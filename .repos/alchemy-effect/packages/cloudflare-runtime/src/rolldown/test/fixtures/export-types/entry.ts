import {
  DurableObject,
  WorkerEntrypoint,
  WorkflowEntrypoint,
} from "cloudflare:workers";

export default {
  fetch: () => new Response("default"),
};

export class NamedEntrypoint extends WorkerEntrypoint {
  greet(name: string) {
    return `hello ${name}`;
  }
}

export class Counter extends DurableObject {}

export class ExampleWorkflow extends WorkflowEntrypoint {
  async run() {}
}

/** A Durable Object written against the original, non-subclassing API. */
export class LegacyDurableObject {
  fetch() {
    return new Response("legacy");
  }
}

/** A named entrypoint declared as an `ExportedHandler` rather than a class. */
export const handlerEntrypoint = {
  fetch: () => new Response("handler"),
};

export const version = "1.0.0";
export const revision = 3;
