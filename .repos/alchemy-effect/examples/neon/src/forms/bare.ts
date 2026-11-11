export default function handler(request: Request) {
  return Response.json({ path: new URL(request.url).pathname });
}
