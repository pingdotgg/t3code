import { Card } from "./components/Card";

// Server-rendered in the Lambda on every request.
export const dynamic = "force-dynamic";

// Title lives on the page (not the layout) so the dev test's hot-reload
// marker rewrite targets this file.
export const metadata = {
  title: "Next.js on AWS",
};

export default function Home() {
  return (
    <main>
      <h1 className="text-3xl font-bold">
        {process.env.GREETING ?? "Hello!"}
      </h1>
      <Card
        title="Styled with Tailwind CSS"
        body="This card is a React component styled with Tailwind utilities."
      />
    </main>
  );
}
