import { RegistryContext } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Atom } from "effect/unstable/reactivity";

/**
 * Whether the Home route can be seen. Home stays mounted under a pushed
 * Thread, and native-stack never freezes the route directly below the focused
 * one on Fabric, so Home has to stop its own work.
 *
 * Driven by the native appear/disappear events rather than focus. A form sheet
 * over Home blurs it but leaves it on screen, and the presenting screen gets no
 * disappear event for it. Home becomes visible as soon as a back swipe or pop
 * starts revealing it, so the list is fresh during the transition.
 */
export function useHomeRouteVisible(): boolean {
  const navigation =
    useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList, "Home">>();
  // A cold deep link mounts Home under its Thread without ever showing it.
  const [visible, setVisible] = useState(() => navigation.isFocused());
  useEffect(() => {
    const show = () => setVisible(true);
    const removeTransitionStart = navigation.addListener("transitionStart", ({ data }) => {
      if (!data.closing) show();
    });
    const removeTransitionEnd = navigation.addListener("transitionEnd", ({ data }) => {
      if (data.closing) setVisible(false);
    });
    // Popping a sheet or a deep-linked route above Home has no appear event.
    const removeFocus = navigation.addListener("focus", show);
    return () => {
      removeTransitionStart();
      removeTransitionEnd();
      removeFocus();
    };
  }, [navigation]);
  return visible;
}

/**
 * Like `useAtomValue`, but unsubscribed while `visible` is false: the last
 * visible value is held and atom changes do not re-render. Resubscribing reads
 * the current value in the same render that turns visibility back on.
 */
export function useAtomValueWhileVisible<A>(atom: Atom.Atom<A>, visible: boolean): A {
  const registry = useContext(RegistryContext);
  const held = useRef<{ readonly value: A } | null>(null);
  const subscribe = useCallback(
    (onChange: () => void) => (visible ? registry.subscribe(atom, onChange) : () => undefined),
    [registry, atom, visible],
  );
  return useSyncExternalStore(subscribe, () => {
    if (visible || held.current === null) held.current = { value: registry.get(atom) };
    return held.current.value;
  });
}
