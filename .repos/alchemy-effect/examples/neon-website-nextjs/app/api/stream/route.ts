export const dynamic = "force-dynamic";

export function GET() {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: first\n\n"));
      timer = setTimeout(() => {
        controller.enqueue(encoder.encode("data: second\n\n"));
        controller.close();
      }, 50);
    },
    cancel() {
      clearTimeout(timer);
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    },
  });
}
