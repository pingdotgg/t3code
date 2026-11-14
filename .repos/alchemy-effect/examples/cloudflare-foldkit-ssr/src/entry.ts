import { Runtime } from "foldkit";
import "./styles.css";

import { Flags, Message, Model, init, update, view } from "./main";

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  container: document.getElementById("root"),
  devTools: {
    Message,
  },
});

Runtime.hydrate(application);
