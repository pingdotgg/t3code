import type { ServerExtension } from "@t3tools/extension-sdk/environment";

const hint = (input: unknown) =>
  typeof input === "object" && input !== null && "clientConnectionId" in input
    ? { clientConnectionId: (input as { clientConnectionId: string }).clientConnectionId }
    : {};

export default {
  tools: [],
  apis: [
    {
      id: "example.ui-theme-session/theme",
      methods: [
        {
          name: "getState",
          invoke: (input, session) =>
            session.invokeApi({
              id: "t3.ui/theme",
              versionRange: "^1.0.0",
              method: "getState",
              input: {},
              ...hint(input),
            }),
        },
        {
          name: "applySessionTheme",
          invoke: (input, session) => {
            const request = input as { theme: string };
            return session.invokeApi({
              id: "t3.ui/theme",
              versionRange: "^1.0.0",
              method: "setPreference",
              input: { mode: "session", theme: request.theme },
              ...hint(input),
            });
          },
        },
      ],
      streams: [],
    },
  ],
} satisfies ServerExtension;
