/// <reference types="@cloudflare/workers-types" />

/**
 * Plain (non-Effect) Worker exposing a NAMED entrypoint alongside its
 * default handler. workerd treats every named class export of an entry
 * module as an entrypoint; `Api` is only reachable through a service
 * binding that names it — the default entrypoint has no `greet`, so a
 * caller succeeding proves the binding targeted the named class.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

export class Api extends WorkerEntrypoint<unknown, Record<string, unknown>> {
  async greet(name: string): Promise<string> {
    return `hello ${name} from Api`;
  }

  /** Echoes the binding's `ctx.props` so callers can assert delivery. */
  async getProps(): Promise<Record<string, unknown>> {
    return this.ctx.props ?? {};
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("hello from EntrypointTargetWorker");
  },
};
