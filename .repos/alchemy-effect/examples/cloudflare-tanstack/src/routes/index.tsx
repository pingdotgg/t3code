import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";

export const getServerTime = createServerFn({
  method: "GET",
}).handler(() => ({
  message: "Hello from a TanStack Start server function.",
  time: new Date().toISOString(),
}));

export const Route = createFileRoute("/")({
  loader: () => getServerTime(),
  component: Home,
});

function Home() {
  const initialData = Route.useLoaderData();
  const [data, setData] = useState(initialData);

  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "4rem 1.5rem",
      }}
    >
      <h1 style={{ margin: 0, fontSize: "2.5rem" }}>TanStack Start</h1>
      <p style={{ marginTop: "1rem", fontSize: "1.125rem", lineHeight: 1.6 }}>
        This is the minimal app scaffold in{" "}
        <code>examples/cloudflare-tanstack</code>.
      </p>
      <p style={{ marginTop: "1rem", lineHeight: 1.6 }}>{data.message}</p>
      <p
        style={{
          padding: "0.75rem 1rem",
          background: "#e2e8f0",
          borderRadius: 8,
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
        }}
      >
        {data.time}
      </p>
      <button
        type="button"
        onClick={async () => {
          setData(await getServerTime());
        }}
        style={{
          padding: "0.75rem 1rem",
          border: "none",
          borderRadius: 8,
          background: "#0f172a",
          color: "#fff",
          cursor: "pointer",
        }}
      >
        Refresh from server
      </button>
    </main>
  );
}
