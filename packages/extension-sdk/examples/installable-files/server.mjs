/** @type {import("@t3tools/extension-sdk/environment").ServerExtension} */
export default {
  tools: [],
  apis: [
    {
      id: "t3.file/presentation",
      methods: [
        {
          name: "open",
          invoke(input, session) {
            session.signal.throwIfAborted();
            return {
              surfaceId: "example.files/view",
              placement: "side-panel",
              restoreState: { relativePath: input.relativePath },
            };
          },
        },
      ],
    },
    {
      id: "example.files/info",
      methods: [
        {
          name: "describe",
          invoke() {
            return { title: "Independent Files provider", readOnly: true };
          },
        },
      ],
    },
  ],
};
