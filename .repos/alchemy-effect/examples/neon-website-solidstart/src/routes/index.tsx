import { createAsync, query } from "@solidjs/router";
import { Suspense } from "solid-js";
import Card from "../components/Card.tsx";
import Counter from "../components/Counter.tsx";

const getGreeting = query(async () => {
  "use server";
  return process.env.GREETING ?? "Hello!";
}, "neon-greeting");

export default function Home() {
  const greeting = createAsync(() => getGreeting());
  return (
    <main>
      <Suspense fallback={<p>Loading greeting...</p>}>
        <h1 class="text-3xl font-bold">{greeting()}</h1>
      </Suspense>
      <Card
        title="Styled with Tailwind CSS"
        body="This card is a Solid component styled with Tailwind utilities."
      />
      <Counter />
    </main>
  );
}
