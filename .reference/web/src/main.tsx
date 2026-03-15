import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RegistryProvider } from "@effect/atom-react"
import { createBrowserHistory, RouterProvider } from "@tanstack/react-router"
import { getRouter } from "./router"
import "./styles.css"

const history = createBrowserHistory()
const router = getRouter(history)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>
  </StrictMode>
)
