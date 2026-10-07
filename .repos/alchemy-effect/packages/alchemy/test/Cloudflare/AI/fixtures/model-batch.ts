export default {
  async fetch(request: Request, env: { AI: Ai }) {
    if (request.method !== "POST") return new Response("ready");
    try {
      const result = await env.AI.run(
        "@cf/baai/bge-m3",
        { requests: [{ text: ["Alchemy subscription batch event"] }] },
        { queueRequest: true },
      );
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
