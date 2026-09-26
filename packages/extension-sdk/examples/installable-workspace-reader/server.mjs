/** @type {import("@t3tools/extension-sdk/environment").ServerExtension} */
const extension = {
  tools: [
    {
      id: "example.installed-reader/read",
      async invoke(input, session) {
        session.signal.throwIfAborted();
        const result = await session.invoke("t3.workspace/read-text", input);
        session.signal.throwIfAborted();
        return result;
      },
    },
  ],
};
export default extension;
