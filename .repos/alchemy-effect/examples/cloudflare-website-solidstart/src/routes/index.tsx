import Card from "~/components/Card";

// Server-rendered in the Cloudflare Worker. Date-default Node.js compatibility
// populates `process.env` from the Worker's environment, so the
// `GREETING` value declared in alchemy.run.ts is read the same way as on
// any Node server.
export default function Home() {
  const greeting =
    (typeof process !== "undefined" && process.env.GREETING) || "Hello!";
  return (
    <main>
      <h1 class="text-3xl font-bold">{greeting}</h1>
      <Card
        title="Styled with Tailwind CSS"
        body="This card is a Solid component styled with Tailwind utilities."
      />
    </main>
  );
}
