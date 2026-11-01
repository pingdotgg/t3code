/** @jsxImportSource react */
import { Card } from "../components/Card.tsx";

// A server component: renders in the Worker on every request. With the
// date-default Node.js compatibility, the `env` declared in
// alchemy.run.ts is populated onto `process.env`.
const Component = () => {
  const greeting = process.env.GREETING ?? "Hello!";
  return (
    <main>
      <h1 className="text-3xl font-bold">{greeting}</h1>
      <Card
        title="Styled with Tailwind CSS"
        body="This card is a React component styled with Tailwind utilities."
      />
    </main>
  );
};

export default Component;
