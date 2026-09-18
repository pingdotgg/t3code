import { getCloudflareContext } from "@opennextjs/cloudflare";
import { signGuestbook } from "./actions.js";

// Server-action mutation path: the form posts to the action, which writes
// to KV; this force-dynamic page reads the latest entry back on render.
export const dynamic = "force-dynamic";

export default async function Guestbook() {
  const { env } = getCloudflareContext();
  const latest = await env.FIXTURE_KV.get("guestbook:latest");
  return (
    <main>
      <h1>GUESTBOOK_MARKER</h1>
      <p>guestbook-latest:{latest ?? "empty"}</p>
      <form action={signGuestbook}>
        <input type="text" name="name" placeholder="name" />
        <button type="submit">Sign</button>
      </form>
    </main>
  );
}
