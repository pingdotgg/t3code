export default {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/echo")
      return new Response(request.body, {
        headers: { "content-type": "application/octet-stream" },
      });
    if (path === "/env")
      return Response.json({
        value: process.env.FUNCTION_TEST_VALUE,
        removed: process.env.FUNCTION_TEST_REMOVED,
        hasDatabase: !!process.env.DATABASE_URL,
        hasAccountKey: !!process.env.NEON_API_KEY,
      });
    if (path === "/cookies") {
      const headers = new Headers();
      headers.append("set-cookie", "one=1; Path=/");
      headers.append("set-cookie", "two=2; Path=/");
      return new Response("cookies", { headers });
    }
    if (path === "/stream")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first\n"));
            controller.enqueue(new TextEncoder().encode("second\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    if (path === "/failure") throw new Error("intentional function fixture failure");
    if (path === "/empty") return new Response(null, { status: 204 });
    console.log("neon-function-native-request");
    return new Response("native-v1");
  },
};
