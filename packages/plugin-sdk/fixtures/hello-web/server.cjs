/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    api.rpc.register("greeting", () => "Hello from the server half of hello-web.", {
      access: "read",
    });
    api.mcp.registerTool(
      {
        name: "greet",
        description: "Greets someone by name.",
        inputSchema: { type: "object", properties: { name: { type: "string" } } },
        access: "read",
      },
      (input) => `Hello, ${input.name ?? "friend"}!`,
    );
  },
};
