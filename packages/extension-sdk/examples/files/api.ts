import { defineApi } from "@t3tools/extension-sdk/capabilities";

export const infoApi = defineApi<{
  describe: { input: Record<string, never>; output: { title: string; readOnly: boolean } };
}>({
  id: "example.files/info",
  version: "1.0.0",
  methods: [
    {
      name: "describe",
      effect: "read",
      requiredGrants: [],
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "readOnly"],
        properties: { title: { type: "string" }, readOnly: { type: "boolean" } },
      },
    },
  ],
});
