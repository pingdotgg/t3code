import Link from "next/link";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main>
      <h1>fixtures-nextjs SSR page</h1>
      <p data-testid="rendered-at">rendered-at:{Date.now()}</p>
      <Link href="/counter" data-testid="counter-link">
        Counter
      </Link>
    </main>
  );
}
