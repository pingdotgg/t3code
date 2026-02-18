import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { AnchoredToastProvider, ToastProvider } from "./components/ui/toast";
import { router } from "./router";
import { StoreProvider } from "./store";

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <StoreProvider>
        <ToastProvider>
          <AnchoredToastProvider>
            <RouterProvider router={router} />
          </AnchoredToastProvider>
        </ToastProvider>
      </StoreProvider>
    </QueryClientProvider>
  );
}
