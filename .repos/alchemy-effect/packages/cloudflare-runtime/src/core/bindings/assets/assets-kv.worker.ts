interface Env {
  ASSETS_FILES: Fetcher;
  ASSETS_REVERSE_MAP: AssetReverseMap;
}

type AssetReverseMap = {
  [pathHash: string]: { filePath: string; contentType: string };
}; //map to actual filepath

export default <ExportedHandler<Env>>{
  async fetch(request, env) {
    // Only permit reads
    if (request.method !== "GET") {
      const message = `Cannot ${request.method.toLowerCase()}() with Workers Assets namespace`;
      return new Response(message, { status: 405, statusText: message });
    }

    const pathHash = new URL(request.url).pathname.substring(1);
    const entry = env.ASSETS_REVERSE_MAP[pathHash];
    if (entry === undefined) {
      return new Response("Not Found", { status: 404 });
    }

    const { filePath, contentType } = entry;
    const response = await env.ASSETS_FILES.fetch(
      new URL(
        // somewhere in blobservice I think this is being decoded again
        filePath
          .split("/")
          .map((x) => encodeURIComponent(x))
          .join("/"),
        "http://placeholder",
      ),
    );
    const newResponse = new Response(response.body, response);
    // ensure the runtime will return the metadata we need
    if (contentType !== null) {
      newResponse.headers.append("cf-kv-metadata", `{"contentType": "${contentType}"}`);
    }
    return newResponse;
  },
};
