export default {
  async fetch() {
    return new Response("OK!");
  },
} satisfies ExportedHandler;
