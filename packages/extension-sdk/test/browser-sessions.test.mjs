import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import {
  BROWSER_DEVTOOLS,
  BROWSER_OPERATE,
  BROWSER_PICTURE_IN_PICTURE,
  BROWSER_SESSIONS,
  BROWSER_SESSIONS_API,
  BROWSER_SESSIONS_API_V1,
  BROWSER_SESSIONS_API_V1_1,
  BROWSER_SESSION_COMMANDS,
  GENERIC_API_CATALOGUE,
  HOST_CAPABILITY_GRANTS,
} from "../dist/catalogue.js";

const methodsOf = (definition) =>
  Object.fromEntries((definition.methods ?? []).map((m) => [m.name, m]));

const sha256 = (definition) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(definition)).digest("hex");
const addedOver = (next, previous) =>
  Object.keys(methodsOf(next)).filter((name) => !(name in methodsOf(previous)));

NodeTest.test(
  "t3.browser/sessions is 1.2.0 with the shipped 1.1.0 and 1.0.0 frozen alongside",
  () => {
    NodeAssert.equal(BROWSER_SESSIONS_API.version, "1.2.0");
    NodeAssert.equal(BROWSER_SESSIONS_API_V1_1.version, "1.1.0");
    NodeAssert.equal(BROWSER_SESSIONS_API_V1.version, "1.0.0");
    NodeAssert.deepEqual(
      GENERIC_API_CATALOGUE.filter((d) => d.id === BROWSER_SESSIONS),
      [BROWSER_SESSIONS_API, BROWSER_SESSIONS_API_V1_1, BROWSER_SESSIONS_API_V1],
    );
    // Content-hash pins of the definitions as published.
    NodeAssert.equal(
      sha256(BROWSER_SESSIONS_API_V1),
      "0de05ead6937c3e46f9b6b010fa6479f5718d04201022945ab3789ce87ca61e6",
    );
    NodeAssert.equal(
      sha256(BROWSER_SESSIONS_API_V1_1),
      "6cb3066f9941f168f198ab9628449243681c7b3e570e3cf1b6ac571cc72a986e",
    );
    NodeAssert.deepEqual(addedOver(BROWSER_SESSIONS_API_V1_1, BROWSER_SESSIONS_API_V1), [
      "openDevTools",
      "closeDevTools",
    ]);
    NodeAssert.deepEqual(addedOver(BROWSER_SESSIONS_API, BROWSER_SESSIONS_API_V1_1), [
      "getFavicon",
      "setPictureInPicture",
    ]);
    // Superset: every 1.1.0 method survives into 1.2.0 with the same grants.
    const current = methodsOf(BROWSER_SESSIONS_API);
    for (const method of BROWSER_SESSIONS_API_V1_1.methods) {
      NodeAssert.deepEqual(current[method.name].requiredGrants, method.requiredGrants, method.name);
    }
  },
);

NodeTest.test("DevTools open and close are distinct operations on their own grant", () => {
  NodeAssert.equal(BROWSER_DEVTOOLS, "t3.browser/devtools");
  const methods = methodsOf(BROWSER_SESSIONS_API);
  for (const name of ["openDevTools", "closeDevTools"]) {
    const method = methods[name];
    NodeAssert.equal(method.effect, "write");
    NodeAssert.deepEqual(method.requiredGrants, [
      BROWSER_SESSIONS,
      BROWSER_OPERATE,
      BROWSER_DEVTOOLS,
    ]);
    // The direction is the operation, not an input flag.
    NodeAssert.deepEqual(method.inputSchema.required, [
      "tabId",
      "serverEpoch",
      "expectedEngineGeneration",
    ]);
    NodeAssert.equal(method.inputSchema.additionalProperties, false);
    // Each returns the shared page-verb receipt.
    NodeAssert.deepEqual(method.outputSchema, methods.reload.outputSchema);
  }
  NodeAssert.equal("setDevToolsOpen" in methods, false);
  // No other brokered operation is authorized by the DevTools grant, and it is
  // not a host-local capability grant either.
  const holders = GENERIC_API_CATALOGUE.flatMap((api) =>
    [...(api.methods ?? []), ...(api.streams ?? [])]
      .filter((operation) => operation.requiredGrants.includes(BROWSER_DEVTOOLS))
      .map((operation) => `${api.id}@${api.version}:${operation.name}`),
  );
  NodeAssert.deepEqual(holders, [
    "t3.browser/sessions@1.2.0:openDevTools",
    "t3.browser/sessions@1.2.0:closeDevTools",
    "t3.browser/sessions@1.1.0:openDevTools",
    "t3.browser/sessions@1.1.0:closeDevTools",
  ]);
  NodeAssert.equal(HOST_CAPABILITY_GRANTS.includes(BROWSER_DEVTOOLS), false);
  NodeAssert.ok(BROWSER_SESSION_COMMANDS.includes("openDevTools"));
  NodeAssert.ok(BROWSER_SESSION_COMMANDS.includes("closeDevTools"));
});

NodeTest.test("1.1.0 sessions carry devToolsOpen; the frozen 1.0.0 does not", () => {
  const session = (definition) => methodsOf(definition).list.outputSchema.properties.sessions.items;
  NodeAssert.ok(session(BROWSER_SESSIONS_API).required.includes("devToolsOpen"));
  NodeAssert.deepEqual(session(BROWSER_SESSIONS_API).properties.devToolsOpen, {
    type: ["boolean", "null"],
  });
  NodeAssert.equal("devToolsOpen" in session(BROWSER_SESSIONS_API_V1).properties, false);
  const commands = (definition) =>
    methodsOf(definition).getCapabilities.outputSchema.properties.commands.items.enum;
  for (const name of ["openDevTools", "closeDevTools"]) {
    NodeAssert.ok(commands(BROWSER_SESSIONS_API).includes(name));
    NodeAssert.equal(commands(BROWSER_SESSIONS_API_V1).includes(name), false);
  }
});

NodeTest.test("1.2.0 keeps picture-in-picture and favicons on their own grants", () => {
  const methods = methodsOf(BROWSER_SESSIONS_API);
  NodeAssert.deepEqual(methods.setPictureInPicture.requiredGrants, [
    BROWSER_SESSIONS,
    BROWSER_PICTURE_IN_PICTURE,
  ]);
  NodeAssert.deepEqual(methods.getFavicon.requiredGrants, [BROWSER_SESSIONS]);
  const holders = GENERIC_API_CATALOGUE.flatMap((api) =>
    [...(api.methods ?? []), ...(api.streams ?? [])]
      .filter((operation) => operation.requiredGrants.includes(BROWSER_PICTURE_IN_PICTURE))
      .map((operation) => `${api.id}@${api.version}:${operation.name}`),
  );
  NodeAssert.deepEqual(holders, ["t3.browser/sessions@1.2.0:setPictureInPicture"]);
  const session = methodsOf(BROWSER_SESSIONS_API).list.outputSchema.properties.sessions.items;
  NodeAssert.ok(session.required.includes("devToolsOpen"));
  NodeAssert.ok(session.required.includes("pictureInPicture"));
  NodeAssert.equal(session.required.includes("faviconRef"), false);
  const v11 = methodsOf(BROWSER_SESSIONS_API_V1_1).list.outputSchema.properties.sessions.items;
  NodeAssert.equal("pictureInPicture" in v11.properties, false);
  NodeAssert.equal("faviconRef" in v11.properties, false);
});
