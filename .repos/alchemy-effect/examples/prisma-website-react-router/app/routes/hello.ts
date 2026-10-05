import type { LoaderFunctionArgs } from "react-router";

export function loader({ request }: LoaderFunctionArgs) {
  return Response.json({
    name: new URL(request.url).searchParams.get("name") ?? "visitor",
    greeting: process.env.GREETING ?? "Hello!",
  });
}
