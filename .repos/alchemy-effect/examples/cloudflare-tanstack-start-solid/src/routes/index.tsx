import { createFileRoute } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { createSignal } from "solid-js";

export const getServerGreeting = createServerFn({
  method: "GET",
}).handler(() => ({
  message: "Hello from TanStack Start Solid on Cloudflare.Website.Vite.",
}));

export const Route = createFileRoute("/")({
  loader: () => getServerGreeting(),
  component: Home,
});

function Home() {
  const initial = Route.useLoaderData();
  const [message, setMessage] = createSignal(initial().message);

  return (
    <main
      style={{
        "max-width": "720px",
        margin: "0 auto",
        padding: "4rem 1.5rem",
      }}
    >
      <h1 style={{ margin: 0, "font-size": "2.5rem" }}>TanStack Start Solid</h1>
      <p style={{ "margin-top": "1rem", "font-size": "1.125rem" }}>
        This app is served by <code>Cloudflare.Website.Vite</code>.
      </p>
      <p data-testid="server-greeting">{message()}</p>
      <button
        type="button"
        onClick={async () => {
          const next = await getServerGreeting();
          setMessage(next.message);
        }}
      >
        Refresh from server
      </button>
    </main>
  );
}
