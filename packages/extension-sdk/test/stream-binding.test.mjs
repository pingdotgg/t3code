import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  ApiVersionError,
  bindStreamApi,
  defineStreamApi,
  resolveResumableStreams,
} from "../dist/capabilities.js";

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

NodeTest.test(
  "resume subscribes through the host's resumable streams, version 1 or later",
  async () => {
    const context = {
      resource: { namespace: "independent.consumer", id: "surface", environmentId: "env" },
      client: "test",
    };
    const plain = [];
    const resumed = [];
    const iterable = (log) => (request) => {
      log.push(request);
      return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) };
    };
    const host = {
      subscribeApi: iterable(plain),
      resumableStreams: { version: 1, subscribeApi: iterable(resumed) },
    };
    const api = defineStreamApi(definition);
    const signal = new AbortController().signal;
    bindStreamApi(api, host, context).subscribe("changes", {}, signal);
    bindStreamApi(api, host, context).subscribe("changes", {}, signal, {
      resume: "fresh-snapshot",
    });
    NodeAssert.equal(plain.length, 1);
    NodeAssert.equal(resumed.length, 1);
    NodeAssert.equal(resumed[0].name, "changes");

    // The plugin's suspension handler reaches the host with the request.
    const handed = [];
    const onSuspended = () => {};
    bindStreamApi(
      api,
      {
        ...host,
        resumableStreams: {
          version: 1,
          subscribeApi: (request, _signal, options) => {
            handed.push(options?.onSuspended);
            return iterable(resumed)(request);
          },
        },
      },
      context,
    ).subscribe("changes", {}, signal, { resume: "fresh-snapshot", onSuspended });
    NodeAssert.deepEqual(handed, [onSuspended]);

    for (const member of [undefined, {}, { version: 0, subscribeApi() {} }, { version: 1 }])
      NodeAssert.equal(resolveResumableStreams({ resumableStreams: member }), null);
    NodeAssert.equal(resolveResumableStreams(host), host.resumableStreams);

    // Per stream: the host must offer the version that added it; unlisted streams never resume.
    const v1 = { resumableStreams: { version: 1, subscribeApi() {} } };
    const v2 = { resumableStreams: { version: 2, subscribeApi() {} } };
    NodeAssert.equal(
      resolveResumableStreams(v1, "t3.terminal/output-events#subscribe"),
      v1.resumableStreams,
    );
    NodeAssert.equal(resolveResumableStreams(v1, "t3.terminal/sessions#list"), null);
    NodeAssert.equal(resolveResumableStreams(v2, "t3.terminal/sessions#list"), v2.resumableStreams);
    const v3 = { resumableStreams: { version: 3, subscribeApi() {} } };
    NodeAssert.equal(resolveResumableStreams(v2, "t3.workspace/changes#subscribeChanges"), null);
    NodeAssert.equal(
      resolveResumableStreams(v3, "t3.workspace/changes#subscribeChanges"),
      v3.resumableStreams,
    );
    const v4 = { resumableStreams: { version: 4, subscribeApi() {} } };
    NodeAssert.equal(resolveResumableStreams(v3, "t3.browser/sessions#events"), null);
    NodeAssert.equal(
      resolveResumableStreams(v4, "t3.browser/sessions#events"),
      v4.resumableStreams,
    );
    for (const stream of ["independent.consumer#changes", "toString"])
      NodeAssert.equal(resolveResumableStreams(v2, stream), null);

    // An older host is refused explicitly, never silently downgraded.
    const older = bindStreamApi(api, { subscribeApi: iterable(plain) }, context).subscribe(
      "changes",
      {},
      signal,
      { resume: "fresh-snapshot" },
    );
    await NodeAssert.rejects(older[Symbol.asyncIterator]().next(), ApiVersionError);
    NodeAssert.equal(plain.length, 1);
  },
);
