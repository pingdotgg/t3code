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
  routing: {
    onUrlRequest: (request) => Message.ClickedLink({ request }),
    onUrlChange: (url) => Message.ChangedUrl({ url }),
  },
  devTools: {
    Message,
  },
});

Runtime.hydrate(application);
