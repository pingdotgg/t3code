import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ cookies }) => {
  const visits = Number(cookies.get("visits") ?? "0") + 1;
  cookies.set("visits", String(visits), { path: "/", httpOnly: false });
  return { visits };
};
