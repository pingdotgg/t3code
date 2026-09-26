export default {
  tools: [],
  apis: [
    {
      id: "example.terminal-output/snapshot",
      methods: [
        {
          name: "readSnapshot",
          invoke: (input, session) =>
            session.invokeApi({
              id: "t3.terminal/output",
              versionRange: "^1.0.0",
              method: "readSnapshot",
              input,
            }),
        },
      ],
    },
  ],
};
