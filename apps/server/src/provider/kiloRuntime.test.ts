import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

import { parseKiloModelSlug, resolveKiloAgent, toKiloPermissionReply } from "./kiloRuntime.ts";

describe("kiloRuntime helpers", () => {
  it("parses providerID/modelID with nested model paths", () => {
    NodeAssert.deepEqual(parseKiloModelSlug("anthropic/claude-sonnet-4-5"), {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    });
    NodeAssert.deepEqual(parseKiloModelSlug("openai/gpt-5/mini"), {
      providerID: "openai",
      modelID: "gpt-5/mini",
    });
    NodeAssert.equal(parseKiloModelSlug("no-slash"), null);
    NodeAssert.equal(parseKiloModelSlug("/leading"), null);
    NodeAssert.equal(parseKiloModelSlug("trailing/"), null);
    NodeAssert.equal(parseKiloModelSlug(null), null);
  });

  it("maps T3 approval decisions to Kilo permission replies", () => {
    NodeAssert.equal(toKiloPermissionReply("accept"), "once");
    NodeAssert.equal(toKiloPermissionReply("acceptForSession"), "always");
    NodeAssert.equal(toKiloPermissionReply("decline"), "reject");
    NodeAssert.equal(toKiloPermissionReply("cancel"), "reject");
  });

  it("resolves plan interaction mode to agent plan, otherwise code", () => {
    NodeAssert.equal(resolveKiloAgent({ interactionMode: "plan" }), "plan");
    NodeAssert.equal(resolveKiloAgent({ interactionMode: "default" }), "code");
    NodeAssert.equal(resolveKiloAgent({}), "code");
    NodeAssert.equal(resolveKiloAgent({ interactionMode: null }), "code");
  });
});
