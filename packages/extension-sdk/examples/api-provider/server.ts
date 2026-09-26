import type { ServerExtension } from "@t3tools/extension-sdk/environment";
import { greetingApi } from "./api.js";

export default {
  apis: [
    {
      id: greetingApi.definition.id,
      methods: [
        {
          name: "greet",
          invoke(_input, session) {
            session.signal.throwIfAborted();
            return { message: "Hello from the provider" };
          },
        },
      ],
    },
  ],
} satisfies Omit<ServerExtension, "tools">;
