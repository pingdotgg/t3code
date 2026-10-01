import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import {
  AGENT_SESSIONS_IMPORT,
  AGENT_SESSIONS_SCAN,
  GENERIC_API_CATALOGUE,
  agentSessionsApi,
  assertProvidedApiOwner,
} from "../dist/catalogue.js";

NodeTest.test("t3.agents/sessions is registered once in the shared catalogue", () => {
  NodeAssert.equal(
    GENERIC_API_CATALOGUE.filter((api) => api.id === agentSessionsApi.definition.id).length,
    1,
  );
  NodeAssert.ok(GENERIC_API_CATALOGUE.includes(agentSessionsApi.definition));
  NodeAssert.doesNotThrow(() =>
    assertProvidedApiOwner("t3.first-party", agentSessionsApi.definition),
  );
});

NodeTest.test("t3.agents/sessions keeps scan and import behind distinct grants", () => {
  const methods = Object.fromEntries(
    agentSessionsApi.definition.methods.map((method) => [method.name, method]),
  );
  NodeAssert.deepEqual(methods.scan.requiredGrants, [AGENT_SESSIONS_SCAN]);
  NodeAssert.equal(methods.scan.effect, "read");
  NodeAssert.deepEqual(methods.import.requiredGrants, [AGENT_SESSIONS_SCAN, AGENT_SESSIONS_IMPORT]);
  NodeAssert.equal(methods.import.effect, "write");
  const catalogueGrants = new Set(
    GENERIC_API_CATALOGUE.flatMap((api) =>
      [...(api.methods ?? []), ...(api.streams ?? [])].flatMap(
        (operation) => operation.requiredGrants,
      ),
    ),
  );
  NodeAssert.ok(catalogueGrants.has(AGENT_SESSIONS_SCAN));
  NodeAssert.ok(catalogueGrants.has(AGENT_SESSIONS_IMPORT));
});
