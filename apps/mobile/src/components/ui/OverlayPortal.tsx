import { type ReactNode, useEffect, useState } from "react";
import { View } from "react-native";

// RN Modals move native window focus and close the keyboard. Keep composer menus in-window.
type Entries = ReadonlyMap<number, ReactNode>;
type Listener = (entries: Entries) => void;

let nextKey = 0;

function allocateKey() {
  return nextKey++;
}
const entries = new Map<number, ReactNode>();
const listeners = new Set<Listener>();

function emit() {
  const snapshot = new Map(entries);
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function OverlayPortal(props: { readonly children: ReactNode }) {
  const [key] = useState(allocateKey);

  // Re-project every render so open menus reflect content and theme changes.
  useEffect(() => {
    entries.set(key, props.children);
    emit();
  });

  useEffect(
    () => () => {
      entries.delete(key);
      emit();
    },
    [key],
  );

  return null;
}

export function OverlayPortalHost() {
  const [current, setCurrent] = useState<Entries>(() => new Map());

  useEffect(() => {
    listeners.add(setCurrent);
    return () => {
      listeners.delete(setCurrent);
    };
  }, []);

  if (current.size === 0) {
    return null;
  }
  return (
    <View pointerEvents="box-none" className="absolute inset-0">
      {[...current.entries()].map(([key, node]) => (
        <View key={key} pointerEvents="box-none" className="absolute inset-0">
          {node}
        </View>
      ))}
    </View>
  );
}
