import assert from "node:assert/strict";
import { join } from "node:path";
// Check that we can actually import unenv polyfilled modules in user source.
import "node:perf_hooks";
// Check that `cloudflare:worker` imports work when `nodejs_compat` is enabled
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export class MyWorkerEntrypoint extends WorkerEntrypoint {}
export class MyDurableObject extends DurableObject {}

export default {
  async fetch() {
    return testBasicNodejsProperties();
  },
} satisfies ExportedHandler;

function testBasicNodejsProperties() {
  assert(true, "the world is broken");

  assert(join("a", "b") === "a/b", "expected posix path joining");

  const buffer1 = Buffer.of(1);
  assert(buffer1.toJSON().data[0] === 1, "Buffer is broken");

  const buffer2 = global.Buffer.of(1);
  assert(buffer2.toJSON().data[0] === 1, "global.Buffer is broken");

  const buffer3 = globalThis.Buffer.of(1);
  assert(buffer3.toJSON().data[0] === 1, "globalThis.Buffer is broken");

  assert(performance !== undefined, "performance is missing");
  assert(global.performance !== undefined, "global.performance is missing");
  assert(globalThis.performance !== undefined, "globalThis.performance is missing");

  assert(Performance !== undefined, "Performance is missing");
  assert(global.Performance !== undefined, "global.Performance is missing");
  assert(globalThis.Performance !== undefined, "globalThis.Performance is missing");

  return new Response(`"OK!"`);
}
