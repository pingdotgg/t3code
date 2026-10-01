import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import {
  BROWSER_SESSIONS,
  BROWSER_SURFACE_COMMANDS,
  GENERIC_API_CATALOGUE,
  RESOURCES_LEASE,
  RESOURCES_LEASE_API,
  RESOURCES_LEASE_API_V1,
  RESOURCE_LEASE_KIND_GRANTS,
  RESOURCE_LEASE_SUPPORTED_KINDS,
  WORKSPACE_RESOURCES,
  resourcesLeaseApi,
  resourcesLeaseApiV1,
} from "../dist/catalogue.js";
import { validateApiDefinition } from "../dist/capabilities.js";

const methodsOf = (definition) =>
  Object.fromEntries((definition.methods ?? []).map((m) => [m.name, m]));

NodeTest.test("t3.resources/lease is 1.1.0 with a frozen 1.0.0 alongside", () => {
  NodeAssert.equal(RESOURCES_LEASE_API.id, RESOURCES_LEASE);
  NodeAssert.equal(RESOURCES_LEASE_API.version, "1.1.0");
  NodeAssert.equal(resourcesLeaseApi.definition, RESOURCES_LEASE_API);
  NodeAssert.equal(RESOURCES_LEASE_API_V1.id, RESOURCES_LEASE);
  NodeAssert.equal(RESOURCES_LEASE_API_V1.version, "1.0.0");
  NodeAssert.equal(resourcesLeaseApiV1.definition, RESOURCES_LEASE_API_V1);
  // Newest first — the shipped 1.0.0 stays selectable for ^1.0.0 consumers.
  NodeAssert.deepEqual(
    GENERIC_API_CATALOGUE.filter((d) => d.id === RESOURCES_LEASE),
    [RESOURCES_LEASE_API, RESOURCES_LEASE_API_V1],
  );
  for (const definition of [RESOURCES_LEASE_API, RESOURCES_LEASE_API_V1]) {
    NodeAssert.deepEqual(validateApiDefinition(definition), definition);
  }
});

NodeTest.test("methods are closed-schema with no method-level grant list", () => {
  for (const definition of [RESOURCES_LEASE_API, RESOURCES_LEASE_API_V1]) {
    const methods = methodsOf(definition);
    // releasePresentation joined in 1.1.0 — the frozen 1.0.0 stays two methods.
    NodeAssert.deepEqual(
      Object.keys(methods).sort(),
      definition.version === "1.1.0"
        ? ["createPresentationUrl", "getCapabilities", "releasePresentation"]
        : ["createPresentationUrl", "getCapabilities"],
    );
    for (const [name, method] of Object.entries(methods)) {
      // Every method stays read-scoped: releasePresentation must remain
      // reachable by the same read authority that minted the claim, or the
      // broker's `effect === "write" && !allowWrite` gate rejects it.
      NodeAssert.equal(method.effect, "read", `${definition.version}:${name}`);
      NodeAssert.equal(method.inputSchema.additionalProperties, false, name);
      // Per-kind grants cannot live on the method — the host adapter enforces
      // RESOURCE_LEASE_KIND_GRANTS at mint time for every caller.
      NodeAssert.deepEqual(method.requiredGrants, [], name);
      NodeAssert.equal(method.outputSchema.additionalProperties, false, name);
    }
  }
});

NodeTest.test(
  "the 1.1.0 resource union mirrors AssetResource plus browser-surface, without unmintable kinds",
  () => {
    const input = methodsOf(RESOURCES_LEASE_API).createPresentationUrl.inputSchema;
    NodeAssert.deepEqual(input.required, ["resource"]);
    const tags = input.properties.resource.oneOf.map((v) => v.properties._tag.const);
    NodeAssert.deepEqual(tags.sort(), [
      "attachment",
      "browser-surface",
      "project-favicon",
      "workspace-file",
    ]);
    for (const variant of input.properties.resource.oneOf) {
      NodeAssert.equal(variant.additionalProperties, false, variant.properties._tag.const);
    }
    // No ws-stream or arbitrary-path kinds leak into the contract.
    for (const banned of ["media-file", "native-app-icon", "device-stream", "ws-stream"]) {
      NodeAssert.ok(!tags.includes(banned), banned);
    }
  },
);

NodeTest.test("the browser-surface ref binds a session identity and a closed command set", () => {
  const variants =
    methodsOf(RESOURCES_LEASE_API).createPresentationUrl.inputSchema.properties.resource.oneOf;
  const surface = variants.find((v) => v.properties._tag.const === "browser-surface");
  NodeAssert.ok(surface, "browser-surface branch exists");
  NodeAssert.deepEqual([...surface.required].sort(), [
    "_tag",
    "allowedCommands",
    "serverEpoch",
    "tabId",
    "threadId",
  ]);
  const commands = surface.properties.allowedCommands;
  NodeAssert.equal(commands.type, "array");
  NodeAssert.equal(commands.minItems, 1);
  NodeAssert.equal(commands.maxItems, BROWSER_SURFACE_COMMANDS.length);
  NodeAssert.equal(commands.uniqueItems, true);
  // Presentation verbs only — engine commands are not encodable in a lease.
  NodeAssert.deepEqual([...commands.items.enum].sort(), ["attach", "present", "release"]);
  NodeAssert.deepEqual([...BROWSER_SURFACE_COMMANDS].sort(), ["attach", "present", "release"]);
});

NodeTest.test("the lease result carries url, expiresAt and the honest claim kind", () => {
  const output = methodsOf(RESOURCES_LEASE_API).createPresentationUrl.outputSchema;
  NodeAssert.deepEqual([...output.required].sort(), ["expiresAt", "kind", "url"]);
  NodeAssert.deepEqual([...output.properties.kind.enum].sort(), [
    "browser-surface",
    "project-favicon",
    "project-favicon-external",
    "workspace-file",
    "workspace-file-exact",
  ]);
});

NodeTest.test("the per-kind grant map and capabilities agree", () => {
  NodeAssert.equal(WORKSPACE_RESOURCES, "t3.workspace/resources");
  NodeAssert.equal(BROWSER_SESSIONS, "t3.browser/sessions");
  NodeAssert.equal(RESOURCE_LEASE_KIND_GRANTS["workspace-file"], WORKSPACE_RESOURCES);
  NodeAssert.equal(RESOURCE_LEASE_KIND_GRANTS["project-favicon"], WORKSPACE_RESOURCES);
  // Only the browser sessions contract holder may mint browser-surface.
  NodeAssert.equal(RESOURCE_LEASE_KIND_GRANTS["browser-surface"], BROWSER_SESSIONS);
  // attachment stays in the union but is unmintable until a grant exists.
  NodeAssert.equal(RESOURCE_LEASE_KIND_GRANTS["attachment"], null);
  NodeAssert.deepEqual([...RESOURCE_LEASE_SUPPORTED_KINDS].sort(), [
    "browser-surface",
    "project-favicon",
    "workspace-file",
  ]);
  const output = methodsOf(RESOURCES_LEASE_API).getCapabilities.outputSchema;
  NodeAssert.deepEqual(output.required, ["supportedKinds"]);
  NodeAssert.deepEqual([...output.properties.supportedKinds.items.enum].sort(), [
    "attachment",
    "browser-surface",
    "project-favicon",
    "workspace-file",
  ]);
});

NodeTest.test("the frozen 1.0.0 keeps the shipped surface byte-identical", () => {
  const input = methodsOf(RESOURCES_LEASE_API_V1).createPresentationUrl.inputSchema;
  const tags = input.properties.resource.oneOf.map((v) => v.properties._tag.const);
  NodeAssert.deepEqual(tags.sort(), ["attachment", "project-favicon", "workspace-file"]);
  for (const banned of [
    "media-file",
    "native-app-icon",
    "browser-surface",
    "device-stream",
    "ws-stream",
  ]) {
    NodeAssert.ok(!tags.includes(banned), banned);
  }
  const kind = methodsOf(RESOURCES_LEASE_API_V1).createPresentationUrl.outputSchema.properties.kind;
  // Copy before sorting — the enum arrays live inside the frozen definition.
  NodeAssert.deepEqual([...kind.enum].sort(), [
    "project-favicon",
    "project-favicon-external",
    "workspace-file",
    "workspace-file-exact",
  ]);
  const kinds =
    methodsOf(RESOURCES_LEASE_API_V1).getCapabilities.outputSchema.properties.supportedKinds.items
      .enum;
  NodeAssert.deepEqual([...kinds].sort(), ["attachment", "project-favicon", "workspace-file"]);
  // Content-hash pin — the frozen definition must not drift silently.
  NodeAssert.equal(
    NodeCrypto.createHash("sha256")
      .update(JSON.stringify(RESOURCES_LEASE_API_V1.methods))
      .digest("hex"),
    "2d590dc457c553c86a0986739ce75b90a037cb2a9841bbd0966441f7f65993ac",
  );
});
