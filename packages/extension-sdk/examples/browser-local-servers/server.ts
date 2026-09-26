import type { ServerExtension } from "@t3tools/extension-sdk/environment";

export default {
  tools: [],
  apis: [
    {
      id: "example.browser-local-servers/read",
      methods: [],
      streams: [
        {
          name: "subscribe",
          async *subscribe(_input, session) {
            for await (const frame of session.subscribeApi({
              id: "t3.browser/local-servers",
              versionRange: "^1.0.0",
              name: "subscribe",
              input: {},
            })) {
              yield { type: frame.type, value: frame.value };
            }
          },
        },
      ],
    },
  ],
} satisfies ServerExtension;
