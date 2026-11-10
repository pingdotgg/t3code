import assert from "node:assert/strict";
import { join } from "node:path";
// oxlint-disable-next-line import/no-unassigned-import
import "node:perf_hooks";
import { stderr } from "./early-process-access";

export default {
  async fetch() {
    assert(stderr, "process.stderr was not polyfilled early enough");
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

    assert(process !== undefined, "process is missing");
    assert(global.process === process, "global.process is not synced");
    assert(globalThis.process === process, "globalThis.process is not synced");

    return new Response("OK!");
  },
} satisfies ExportedHandler;
