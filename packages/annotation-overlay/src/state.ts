import { createStore, useStore, type Store } from "./core/store";
import type { DictationSettings } from "./dictation";
import type { Annotation, AnnotationDraft, HoverTarget } from "./types";

export type Ref<T> = {
  get value(): T;
  set value(next: T);
  store: Store<T>;
};

export function createRef<T>(initial: T): Ref<T> {
  const store = createStore(initial);

  return {
    get value() {
      return store.getSnapshot();
    },
    set value(next: T) {
      store.setState(next);
    },
    store,
  };
}

export function useRefValue<T>(ref: Ref<T>): T {
  return useStore(ref.store);
}

export const floatingControl = createRef(true);
export const annotationMode = createRef(false);
export const annotations = createRef<Annotation[]>([]);
export const draft = createRef<AnnotationDraft | null>(null);
/** Drafts whose dictation is being transcribed; each saves when its transcript arrives. */
export type FinishingDraft = { session: string; draft: AnnotationDraft; typed: string };
export const finishing = createRef<FinishingDraft[]>([]);
export const hover = createRef<HoverTarget | null>(null);
/** Hides the hover label while the button is down, so the click's screenshot leaves it out. */
export const hoverLabelHidden = createRef(false);
export const shakeToken = createRef(0);
export const viewportTick = createRef(0);
export const dictationSettings = createRef<DictationSettings>({});
