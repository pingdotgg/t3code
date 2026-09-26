export default {
  tools: [],
  apis: [
    {
      id: "example.terminal-live-output/events",
      methods: [],
      streams: [
        {
          name: "subscribe",
          async *subscribe(input, session) {
            for await (const frame of session.subscribeApi({
              id: "t3.terminal/output-events",
              versionRange: "^1.0.0",
              name: "subscribe",
              input,
              ...(session.resumeCursor === undefined ? {} : { cursor: session.resumeCursor }),
            })) {
              yield { type: frame.type, value: frame.value };
            }
          },
        },
      ],
    },
  ],
};
