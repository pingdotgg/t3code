import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as catalogue from "../dist/catalogue.js";

NodeTest.test(
  "clone and source-control discovery are independently granted environment APIs",
  () => {
    const clone = catalogue.projectsCloneApi;
    const discovery = catalogue.sourceControlDiscoveryApi;
    NodeAssert.ok(clone, "project clone contract is available");
    NodeAssert.ok(discovery, "source-control discovery contract is available");
    for (const api of [clone, discovery]) {
      NodeAssert.equal(api.definition.version, "1.0.0");
      NodeAssert.equal(api.baseline, "1.0.0");
      NodeAssert.ok(catalogue.GENERIC_API_CATALOGUE.includes(api.definition));
      NodeAssert.doesNotThrow(() =>
        catalogue.assertProvidedApiOwner("fixture.consumer", api.definition),
      );
    }
    for (const method of clone.definition.methods) {
      NodeAssert.deepEqual(method.requiredGrants, ["t3.projects/create"]);
      NodeAssert.equal(method.effect, "write");
    }
    NodeAssert.deepEqual(clone.definition.streams[0].requiredGrants, ["t3.projects/create"]);
    for (const method of discovery.definition.methods) {
      NodeAssert.deepEqual(method.requiredGrants, ["t3.source-control/read"]);
      NodeAssert.equal(method.effect, "read");
    }
    const input = clone.definition.methods.find((method) => method.name === "start").inputSchema;
    NodeAssert.equal(input.additionalProperties, false);
    NodeAssert.equal(input.properties.destinationPath, undefined);
    NodeAssert.equal(input.properties.projectId, undefined);
    NodeAssert.ok(input.required.includes("destinationName"));
  },
);
