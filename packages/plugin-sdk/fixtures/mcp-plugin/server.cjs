// Plain CommonJS with no SDK import, so the plugin host loads it as is. The type comes from the SDK.

/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    api.mcp.registerTool(
      {
        name: "echo",
        description: "Returns the text it is given.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        access: "read",
      },
      (input) => ({ echoed: input.text ?? null }),
    );
    let touches = 0;
    api.mcp.registerTool(
      {
        name: "touch",
        description: "Counts how many times it was called.",
        inputSchema: { type: "object", properties: {} },
        access: "write",
      },
      () => ({ touches: ++touches }),
    );
  },
};
