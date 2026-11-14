/* @refresh reload */
import "solid-devtools";
import "./index.css";
import { Router } from "@solidjs/router";
import { hydrate, render } from "solid-js/web";
import App from "./app";
import { routes } from "./routes";

const root = document.getElementById("root")!;

const app = () => <Router root={(props) => <App>{props.children}</App>}>{routes}</Router>;

// Use hydrate when server-rendered content is present, otherwise render (dev mode)
if (root.children.length > 0) {
  hydrate(app, root);
} else {
  render(app, root);
}
