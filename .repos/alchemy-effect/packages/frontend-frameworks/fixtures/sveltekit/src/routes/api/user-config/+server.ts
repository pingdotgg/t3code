import { version } from "$app/env";
import { json } from "@sveltejs/kit";
import { marker } from "virtual:fixture-marker";
import { greeting } from "#fixture/greeting.js";
import type { RequestHandler } from "./$types";

/**
 * Observable proof (live AND dev) that the user's `vite.config.ts` is loaded
 * natively: `version` comes from the user's kit `version.name` option and
 * `virtual:fixture-marker` is a user Vite plugin's virtual module. `greeting`
 * resolves through a `package.json` subpath import (kit v3's replacement for
 * `$lib`-style aliases).
 */
export const GET: RequestHandler = () => json({ marker, version, greeting });
