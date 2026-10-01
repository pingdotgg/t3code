import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { BROWSER_SESSIONS_API } from "../dist/catalogue.js";

NodeTest.test(
  "browser sessions retain the integration contract without per-action observations",
  () => {
    const methods = Object.fromEntries(
      BROWSER_SESSIONS_API.methods.map((method) => [method.name, method]),
    );
    const session = methods.list.outputSchema.properties.sessions.items.properties;
    NodeAssert.equal("controller" in session, false);
    NodeAssert.equal("remoteLive" in session, false);
  },
);
