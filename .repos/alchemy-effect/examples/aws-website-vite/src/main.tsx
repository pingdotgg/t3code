import React from "react";
import ReactDOM from "react-dom/client";
import { Card } from "./components/Card.tsx";
import "./styles/global.css";

// A client-only SPA has no server environment — the greeting is a literal.
function App() {
  return (
    <>
      <h1 className="text-3xl font-bold">Hello from Vite!</h1>
      <Card
        title="Styled with Tailwind CSS"
        body="This card is a React component styled with Tailwind utilities."
      />
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
