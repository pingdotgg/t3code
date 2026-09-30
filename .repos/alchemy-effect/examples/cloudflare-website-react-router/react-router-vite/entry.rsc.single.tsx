/// <reference types="@vitejs/plugin-rsc/types" />
import { fetchServer } from "./entry.rsc";

export default async function handler(request: Request) {
  const ssr = await import.meta.viteRsc.loadModule<
    typeof import("./entry.ssr")
  >("ssr", "index");

  return ssr.default(request, await fetchServer(request));
}
