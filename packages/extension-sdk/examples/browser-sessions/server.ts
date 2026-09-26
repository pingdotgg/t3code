import type { ServerExtension } from "@t3tools/extension-sdk/environment";

const sessions = "t3.browser/sessions";
const methods = ["getCapabilities", "list", "open", "navigate", "close", "back"];

export default {
  tools: [],
  apis: [
    {
      id: "example.browser-sessions/mirror",
      methods: methods.map((name) => ({
        name,
        invoke: (input, session) =>
          session.invokeApi({
            id: sessions,
            versionRange: "^1.0.0",
            method: name,
            input,
          }),
      })),
      streams: [
        {
          name: "events",
          async *subscribe(_input, session) {
            for await (const frame of session.subscribeApi({
              id: sessions,
              versionRange: "^1.0.0",
              name: "events",
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
