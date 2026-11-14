// workerd supports `using` natively, so the Worker build should keep it
export default {
  async fetch() {
    const disposed: string[] = [];
    {
      await using _session = {
        async [Symbol.asyncDispose]() {
          disposed.push("session");
        },
      };
      using _socket = {
        [Symbol.dispose]() {
          disposed.push("socket");
        },
      };
    }
    return Response.json(disposed);
  },
} satisfies ExportedHandler;
