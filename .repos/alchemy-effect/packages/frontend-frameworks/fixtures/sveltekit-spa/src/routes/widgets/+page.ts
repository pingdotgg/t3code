import { describeWidgets, type Widget } from "$spa/widgets";

export interface WidgetsPayload {
  readonly server: boolean;
  readonly message: string | null;
  readonly widgets: ReadonlyArray<Widget>;
}

/**
 * A UNIVERSAL load (`+page.ts`). With `ssr = false` it runs exclusively in
 * the browser — yet the `/api/widgets` endpoint it fetches runs server-side
 * in the worker. That split (client-run load, server-run endpoint) is the
 * point of this fixture.
 */
export const load = async ({ fetch }: { fetch: typeof globalThis.fetch }) => {
  const response = await fetch("/api/widgets");
  const payload = (await response.json()) as WidgetsPayload;
  return {
    ...payload,
    description: describeWidgets(payload.widgets),
  };
};
