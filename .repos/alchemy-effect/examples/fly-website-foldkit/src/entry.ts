import "./styles/global.css";

import { Runtime } from "foldkit";

import { init, Model, update, view } from "./main.ts";

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById("root"),
});

Runtime.run(application);
