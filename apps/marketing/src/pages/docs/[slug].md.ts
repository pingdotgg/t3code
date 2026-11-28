import type { APIRoute, GetStaticPaths } from "astro";

import { getDocsCatalog } from "../../lib/docs";

export const getStaticPaths: GetStaticPaths = async () => {
  const catalog = await getDocsCatalog();
  return catalog.docs
    .filter((doc) => doc.slug !== null)
    .map((doc) => ({
      params: { slug: doc.slug! },
      props: { body: doc.entry.body ?? "" },
    }));
};

export const GET: APIRoute = ({ props }) =>
  new Response(String(props.body ?? ""), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
