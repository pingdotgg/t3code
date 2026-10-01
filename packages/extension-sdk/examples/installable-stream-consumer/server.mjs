export default {
  tools: [],
  apis: [
    {
      id: "example.stream-consumer/state",
      methods: [],
      streams: [
        {
          name: "changes",
          async *subscribe(_input, session) {
            for await (const frame of session.subscribeApi({
              id: "example.stream-provider/state",
              versionRange: "^1.0.0",
              name: "changes",
              input: {},
              ...(session.resumeCursor === undefined ? {} : { cursor: session.resumeCursor }),
            })) {
              yield {
                type: frame.type,
                value: frame.value,
                ...(frame.cursor === undefined ? {} : { cursor: frame.cursor }),
              };
            }
          },
        },
      ],
    },
  ],
};
