import { Card } from "./components/Card";
import { Counter } from "./components/Counter";
import { submitName } from "./actions";
import Image from "next/image";

// Server-rendered in the Neon Functions runtime on every request.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Next.js on Neon",
};

export default async function Home({ searchParams }) {
  const { submitted } = await searchParams;
  return (
    <main>
      <h1 className="text-3xl font-bold">{process.env.GREETING ?? "Hello!"}</h1>
      <Card
        title="Styled with Tailwind CSS"
        body="This card is a React component styled with Tailwind utilities."
      />
      <Image
        src="/logo.svg"
        alt="Neon Website"
        width={160}
        height={48}
        unoptimized
      />
      <Counter />
      <form action={submitName}>
        <label htmlFor="name">Your name</label>
        <input id="name" name="name" required maxLength={64} />
        <button type="submit">Submit name</button>
      </form>
      {submitted && <p role="status">Submitted: {submitted}</p>}
      <a href="/api/stream">Stream events</a>
      <a href="/redirect">Follow redirect</a>
    </main>
  );
}
