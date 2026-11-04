import { refresh } from "./actions.ts";

export const revalidate = 30;

export default function ActionsPage() {
  return (
    <form action={refresh}>
      <button type="submit">VINEXT_FIXTURE_ACTION</button>
    </form>
  );
}
