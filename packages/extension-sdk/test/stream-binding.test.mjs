import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { bindStreamApi, defineStreamApi } from "../dist/capabilities.js";

const definition = {
  id: "independent.consumer/events",
  version: "1.0.0",
  methods: [],
  streams: [
    {
      name: "changes",
      inputSchema: { type: "object" },
      eventSchema: { type: "object" },
      requiredGrants: [],
    },
  ],
};
NodeTest.test(
  "stream descriptors reject method-only definitions before authoring a subscription",
  () => {
    NodeAssert.throws(
      () =>
        defineStreamApi({
          id: "independent.consumer/read",
          version: "1.0.0",
          methods: [
            { name: "read", effect: "read", inputSchema: {}, outputSchema: {}, requiredGrants: [] },
          ],
        }),
      /stream definitions/,
    );
  },
);
NodeTest.test(
  "public stream binding retains host iterator cleanup, signal, context and selected version",
  async () => {
    const controller = new AbortController();
    const context = {
      resource: { namespace: "independent.consumer", id: "surface", environmentId: "env" },
      client: "test",
    };
    const frame = { type: "data", streamId: "host-stream", sequence: 1, value: { value: 42 } };
    let received,
      receivedSignal,
      returned = 0;
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: false, value: frame }),
          return: async () => {
            returned++;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const client = {
      subscribeApi(request, signal) {
        received = request;
        receivedSignal = signal;
        return iterable;
      },
    };
    const api = defineStreamApi(definition);
    const stream = bindStreamApi(api, client, context, ">=1.0.0 <2").subscribe(
      "changes",
      { selected: true },
      controller.signal,
      { cursor: "opaque", expectedGeneration: 7, id: "other", context: {} },
    );
    NodeAssert.equal(stream, iterable);
    for await (const actual of stream) {
      NodeAssert.equal(actual, frame);
      break;
    }
    NodeAssert.equal(returned, 1, "breaking consumer releases the host iterator");
    NodeAssert.equal(receivedSignal, controller.signal);
    controller.abort();
    NodeAssert.equal(receivedSignal.aborted, true);
    NodeAssert.deepEqual(received, {
      id: definition.id,
      versionRange: ">=1.0.0 <2",
      name: "changes",
      input: { selected: true },
      context,
      cursor: "opaque",
      expectedGeneration: 7,
    });
  },
);

NodeTest.test(
  "an independently packaged provider retains the exact old terminal output contract",
  async () => {
    const { readFile } = await import("node:fs/promises");
    const { TERMINAL_OUTPUT_API } = await import("../dist/catalogue.js");
    const { validateEnvironmentPackage, validateServerExtension } =
      await import("../dist/environment.js");
    const legacy = JSON.parse(
      await readFile(new URL("./fixtures/terminal-output-v1.json", import.meta.url), "utf8"),
    );
    NodeAssert.deepEqual(TERMINAL_OUTPUT_API, legacy);
    const pkg = validateEnvironmentPackage({
      format: 2,
      manifest: {
        id: "independent.legacy-terminal",
        version: "1.0.0",
        apiVersion: 1,
        surfaces: [],
      },
      serverEntry: "server.mjs",
      tools: [],
      dependencies: [],
      requires: [],
      provides: [legacy],
    });
    const executable = validateServerExtension(pkg, {
      tools: [],
      apis: [{ id: legacy.id, methods: [{ name: "readSnapshot", invoke: async () => null }] }],
    });
    NodeAssert.equal(executable.apis[0].id, "t3.terminal/output");
  },
);
