import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { Ajv } from "ajv";
import { uiKeybindingsApi } from "@t3tools/extension-sdk/catalogue";

// The broker compiles API schemas with strict draft-7 Ajv; mirror that here.
const registerCommands = uiKeybindingsApi.definition.methods.find(
  (method) => method.name === "registerCommands",
);
const validate = new Ajv({ strict: true, addUsedSchema: false }).compile(
  registerCommands.inputSchema,
);
const accepts = (defaultKey) =>
  validate({
    commands: [
      {
        id: "zoomIn",
        title: "Zoom In",
        scope: "surface",
        ...(defaultKey === undefined ? {} : { defaultKey }),
      },
    ],
  });

NodeTest.test("command descriptors accept a single default key or a bounded list", () => {
  NodeAssert.equal(accepts(undefined), true);
  NodeAssert.equal(accepts("mod+="), true);
  NodeAssert.equal(accepts(["mod+=", "mod++"]), true);
  NodeAssert.equal(accepts([]), false);
  NodeAssert.equal(accepts(["mod+=", "mod+="]), false);
  NodeAssert.equal(accepts(["a", "b", "c", "d", "e"]), false);
  NodeAssert.equal(accepts(["mod+=", ""]), false);
  NodeAssert.equal(accepts(42), false);
});

NodeTest.test(
  "defaultKeyLogicalOnly is 1.2.0-only: a closed 1.1.0 descriptor schema rejects it",
  () => {
    NodeAssert.equal(uiKeybindingsApi.definition.version, "1.2.0");
    const descriptor = { id: "clear", title: "Clear", scope: "surface", defaultKey: "ctrl+l" };
    const commands = registerCommands.inputSchema.properties.commands;
    const { defaultKeyLogicalOnly: _added, ...oldProperties } = commands.items.properties;
    const validateOld = new Ajv({ strict: true, addUsedSchema: false }).compile({
      ...registerCommands.inputSchema,
      properties: {
        ...registerCommands.inputSchema.properties,
        commands: { ...commands, items: { ...commands.items, properties: oldProperties } },
      },
    });
    NodeAssert.equal(validateOld({ commands: [descriptor] }), true);
    NodeAssert.equal(
      validateOld({ commands: [{ ...descriptor, defaultKeyLogicalOnly: true }] }),
      false,
    );
    NodeAssert.equal(
      validate({ commands: [{ ...descriptor, defaultKeyLogicalOnly: true }] }),
      true,
    );
  },
);
