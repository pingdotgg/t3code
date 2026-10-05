import { Counter } from "./components/Counter.tsx";
import { Card } from "./components/Card.tsx";

export default function Home() {
  return (
    <main>
      <h1 className="text-3xl font-bold">Hello from vinext on Railway!</h1>
      <Card
        title="Styled with Tailwind CSS"
        body="This card is a React component styled with Tailwind utilities."
      />
      <Counter />
    </main>
  );
}
