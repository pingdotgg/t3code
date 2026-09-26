import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { bindApi, validateApiDefinition } from "../dist/capabilities.js";
import { workspaceFilesApi, FILE_PRESENTATION_API } from "../dist/catalogue.js";
import { validateEnvironmentPackage, validateServerExtension } from "../dist/environment.js";
const manifest = { id: "example.files", apiVersion: 1, version: "1.0.0", surfaces: [] };
const pkg = {
  format: 2,
  manifest,
  serverEntry: "server.mjs",
  tools: [],
  dependencies: [],
  provides: [FILE_PRESENTATION_API],
  requires: [],
};
NodeTest.test(
  "format2 shared providers preserve exact contracts and executable method handshake",
  () => {
    NodeAssert.equal(validateEnvironmentPackage(pkg).format, 2);
    NodeAssert.throws(
      () =>
        validateEnvironmentPackage({
          ...pkg,
          provides: [
            {
              ...FILE_PRESENTATION_API,
              methods: [{ ...FILE_PRESENTATION_API.methods[0], requiredGrants: [] }],
            },
          ],
        }),
      /contract/,
    );
    NodeAssert.throws(() => validateServerExtension(pkg, { tools: [] }), /APIs/);
    NodeAssert.throws(
      () =>
        validateServerExtension(pkg, {
          tools: [],
          apis: [{ id: FILE_PRESENTATION_API.id, methods: [{ name: "wrong", invoke() {} }] }],
        }),
      /methods/,
    );
    NodeAssert.equal(
      validateServerExtension(pkg, {
        tools: [],
        apis: [
          {
            id: FILE_PRESENTATION_API.id,
            methods: [
              {
                name: "open",
                invoke() {
                  return null;
                },
              },
            ],
          },
        ],
      }).apis.length,
      1,
    );
    NodeAssert.equal(
      validateEnvironmentPackage({ format: 1, manifest, serverEntry: "server.mjs", tools: [] })
        .format,
      1,
    );
  },
);
NodeTest.test("malformed API descriptors and external schema refs fail before registration", () => {
  for (const bad of [
    null,
    {},
    { id: "example.files/api", version: "1.0.0" },
    { ...FILE_PRESENTATION_API, methods: [null] },
    {
      ...FILE_PRESENTATION_API,
      methods: [
        { ...FILE_PRESENTATION_API.methods[0], inputSchema: { $ref: "https://example.com" } },
      ],
    },
  ])
    NodeAssert.throws(() => validateApiDefinition(bad));
});
NodeTest.test(
  "typed binding delivers public invocation and result without private host imports",
  async () => {
    const context = {
      resource: { namespace: "example.files", id: "root", environmentId: "env" },
      client: "web",
    };
    let received;
    const client = {
      async invokeApi(request, signal) {
        received = request;
        NodeAssert.equal(signal.aborted, false);
        return { entries: [], nextCursor: null };
      },
    };
    const result = await bindApi(workspaceFilesApi, client, context).invoke(
      "listEntries",
      { relativePath: "" },
      new AbortController().signal,
    );
    NodeAssert.deepEqual(result, { entries: [], nextCursor: null });
    NodeAssert.equal(received.id, "t3.workspace/files");
    NodeAssert.equal(received.context, context);
  },
);

NodeTest.test("package versions preserve semver build metadata", () => {
  NodeAssert.equal(
    validateEnvironmentPackage({ ...pkg, manifest: { ...manifest, version: "1.0.0+build.1" } })
      .manifest.version,
    "1.0.0+build.1",
  );
});
