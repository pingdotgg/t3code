export function GET() {
  return Response.json(
    { config: "native-open-next" },
    { headers: { "x-config-priority": "handler" } },
  );
}
