import { Runtime } from "foldkit";
import "./styles.css";

import { Flags, init, Message, Model, update, view } from "./main.ts";

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  container: document.getElementById("root"),
});

// The document arrives rendered: adopt it rather than rebuild it. The build
// id is what hydration compares against the one the server stamped.
Runtime.hydrate(application);
