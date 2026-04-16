import { createExternalStore } from "../../lib/createExternalStore";

const store = createExternalStore<string | null>(null);

export const setMessageCopyText = (text: string) => store.set(text);
export const clearMessageCopyText = () => store.set(null);
export const useMessageCopyText = store.useValue;
