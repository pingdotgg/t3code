import "./styles.css";

import { Runtime } from "foldkit";

import { Flags, init, Message, Model, update, view } from "./main.ts";

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  container: document.getElementById("root"),
});

// HYDRATE, not run: the document arrives already rendered, so the client
// adopts that DOM instead of rebuilding it. The Flags the server used are
// read back out of the page — `hydrate` takes no Flags producer of its own.
// The build id is what makes adoption safe: hydration compares it against the
// one the server stamped and refuses a page from another deployment.
Runtime.hydrate(application, { buildId: import.meta.env.FOLDKIT_BUILD_ID });
