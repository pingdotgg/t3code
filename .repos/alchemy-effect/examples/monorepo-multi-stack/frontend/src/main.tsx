import { BackendClient } from "@monorepo-multi-stack/backend/Client";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import React from "react";
import ReactDOM from "react-dom/client";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

const client = BackendClient(API_URL).pipe(
  Effect.provide(FetchHttpClient.layer),
);

function App() {
  const [message, setMessage] = React.useState<string>("loading…");

  React.useEffect(() => {
    client
      .pipe(
        Effect.flatMap((client) => client.Hello.hello()),
        Effect.map((greeting) => greeting.message),
        Effect.runPromise,
      )
      .then(setMessage, (err) => setMessage(`error: ${String(err)}`));
  }, []);

  return (
    <main>
      <h1>{message}</h1>
      <p>
        Edit <code>src/main.tsx</code> and redeploy.
      </p>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
