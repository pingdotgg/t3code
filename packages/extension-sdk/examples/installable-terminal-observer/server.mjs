export default {
  tools: [],
  apis: [
    {
      id: "example.terminal-observer/status",
      methods: [
        {
          name: "inspect",
          invoke: (input, session) =>
            session.invokeApi({
              id: "t3.terminal/sessions",
              versionRange: "^1.0.0",
              method: "inspect",
              input,
            }),
        },
      ],
    },
  ],
};
