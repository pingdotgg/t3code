function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamResponse(writable: WritableStream) {
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  await writer.write(
    encoder.encode(`
<!DOCTYPE html>
<html>
<head>
	<title>Streaming example</title>
</head>
<body>
	<h1>Streaming example</h1>
	<p>Loading content...</p>
		`),
  );

  await sleep(1000);
  await writer.write(encoder.encode(`<p id="one">Chunk after 1 second`));
  await sleep(1000);
  await writer.write(
    encoder.encode(`
	<p id="two">Chunk after 2 seconds</p>
</body></html>
		`),
  );
  await writer.close();
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const { readable, writable } = new TransformStream();

      void streamResponse(writable);

      return new Response(readable, {
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
    } else {
      return new Response(null, { status: 404 });
    }
  },
} satisfies ExportedHandler;
