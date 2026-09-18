import { greeting } from "$fixture/greeting";
import { json } from "@sveltejs/kit";
import { marker } from "virtual:fixture-marker";
import type { RequestHandler } from "./$types";

/**
 * Observable proof (live AND dev) that the user's `vite.config.ts` is loaded
 * natively: `$fixture` is a user kit alias, `virtual:fixture-marker` is a
 * user Vite plugin's virtual module. Either import fails the build/request if
 * the user config were ignored.
 */
export const GET: RequestHandler = () => json({ marker, greeting });
