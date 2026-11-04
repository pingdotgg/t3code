/** @jsxImportSource react */
import { createFileRoute } from "@tanstack/react-router";

const marker = "hmr-marker-fixture";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <main>{marker}</main>;
}
