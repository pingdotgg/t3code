import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import {
  GENERIC_API_CATALOGUE,
  WORKSPACE_SEARCH,
  WORKSPACE_SEARCH_API,
  workspaceSearchApi,
} from "../dist/catalogue.js";

const methods = Object.fromEntries(WORKSPACE_SEARCH_API.methods.map((m) => [m.name, m]));

NodeTest.test("t3.workspace/search is a frozen 1.0.0 catalogue contract with both methods", () => {
  NodeAssert.equal(WORKSPACE_SEARCH_API.id, "t3.workspace/search");
  NodeAssert.equal(WORKSPACE_SEARCH_API.version, "1.0.0");
  NodeAssert.deepEqual(
    GENERIC_API_CATALOGUE.filter((d) => d.id === WORKSPACE_SEARCH),
    [WORKSPACE_SEARCH_API],
  );
  NodeAssert.equal(workspaceSearchApi.definition, WORKSPACE_SEARCH_API);
  NodeAssert.deepEqual(Object.keys(methods).sort(), ["search", "searchContents"]);
  for (const method of Object.values(methods)) {
    NodeAssert.equal(method.effect, "read");
    NodeAssert.deepEqual(method.requiredGrants, ["t3.workspace/search"]);
  }
});

NodeTest.test("search method bounds mirror the native projectsSearchEntries bounds", () => {
  const { inputSchema, outputSchema } = methods.search;
  NodeAssert.equal(inputSchema.additionalProperties, false);
  NodeAssert.deepEqual(inputSchema.required, ["query"]);
  NodeAssert.equal(inputSchema.properties.query.maxLength, 256);
  NodeAssert.deepEqual(
    [inputSchema.properties.limit.minimum, inputSchema.properties.limit.maximum],
    [1, 200],
  );
  NodeAssert.deepEqual(inputSchema.properties.kind.enum, ["file", "directory"]);
  NodeAssert.equal(outputSchema.properties.entries.maxItems, 200);
  NodeAssert.equal(outputSchema.required.includes("truncated"), true);
});

NodeTest.test("searchContents bounds mirror the native projectsSearchContents bounds", () => {
  const { inputSchema, outputSchema } = methods.searchContents;
  NodeAssert.equal(inputSchema.additionalProperties, false);
  NodeAssert.deepEqual(inputSchema.required, ["query"]);
  NodeAssert.equal(inputSchema.properties.query.minLength, 1);
  NodeAssert.equal(inputSchema.properties.query.maxLength, 256);
  NodeAssert.deepEqual(
    [inputSchema.properties.limit.minimum, inputSchema.properties.limit.maximum],
    [1, 500],
  );
  NodeAssert.equal(outputSchema.properties.matches.maxItems, 500);
  NodeAssert.equal(outputSchema.required.includes("truncated"), true);
});
