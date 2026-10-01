import Card from "../components/Card.tsx";

// Server-rendered on every request inside the Hetzner Server systemd unit.
// Environment values declared in alchemy.run.ts are available on
// `process.env`.
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
