import { getCloudflareContext } from "@opennextjs/cloudflare";
import { Card } from "./components/Card";

// Server-rendered in the Worker on every request.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Next.js on Cloudflare",
};

export default function Home() {
  const { env } = getCloudflareContext();
  return (
    <main>
      <h1 className="text-3xl font-bold">{env.GREETING ?? "Hello!"}</h1>
      <Card
        title="Styled with Tailwind CSS"
        body="This card is a React component styled with Tailwind utilities."
      />
    </main>
  );
}
