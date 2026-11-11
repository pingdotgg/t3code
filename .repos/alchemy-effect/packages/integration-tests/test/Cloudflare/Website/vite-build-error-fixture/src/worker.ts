// Deliberately broken: `missing` is not exported by `./lib.ts`, so the
// SSR build fails with rolldown's MISSING_EXPORT diagnostic.
// @ts-expect-error -- the missing export is the point of this fixture
import { missing } from "./lib.ts";

export default {
  fetch(): Response {
    return new Response(missing);
  },
};
