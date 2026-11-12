import { initClient, initClientNavigation } from "rwsdk/client";

// RedwoodSDK uses RSC RPC to emulate client side navigation.
// https://docs.rwsdk.com/guides/frontend/client-side-nav/
const { handleResponse, onHydrated } = initClientNavigation();
initClient({ handleResponse, onHydrated });
