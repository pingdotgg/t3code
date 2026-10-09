import { Card } from "./components/Card";
import { Counter } from "./components/Counter";

// Server-rendered in the Prisma Compute runtime on every request.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Next.js on Prisma",
};

export default function Home() {
  return (
    <main>
      <h1 className="text-3xl font-bold">{process.env.GREETING ?? "Hello!"}</h1>
      <Card
        title="Styled with Tailwind CSS"
        body="This card is a React component styled with Tailwind utilities."
      />
      <Counter />
    </main>
  );
}
