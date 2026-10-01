import { defineApi } from "@t3tools/extension-sdk/capabilities";

export const greetingApi = defineApi<{
  greet: { input: Record<string, never>; output: { message: string } };
}>({
  id: "example.greeting/message",
  version: "1.0.0",
  methods: [
    {
      name: "greet",
      effect: "read",
      requiredGrants: [],
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: { message: { type: "string", maxLength: 200 } },
      },
    },
  ],
});
