export default {
  fetch() {
    return new Response("from auxiliary Worker");
  },
} satisfies ExportedHandler;
