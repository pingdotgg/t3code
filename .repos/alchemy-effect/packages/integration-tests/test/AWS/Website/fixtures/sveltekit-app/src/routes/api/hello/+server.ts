import { json } from "@sveltejs/kit";

export const GET = ({ url }: { url: URL }) => {
  return json({
    marker: "SVELTEKIT_AWS_API_MARKER",
    echo: url.searchParams.get("echo"),
  });
};
