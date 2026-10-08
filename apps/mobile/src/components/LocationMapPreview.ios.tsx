import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { requireOptionalNativeModule } from "expo";
import { Image } from "expo-image";

import { uuidv4 } from "../lib/uuid";
import { AppText } from "./AppText";
import type { LocationMapPreviewProps } from "./LocationMapPreview.types";

type SnapshotModule = {
  createLocationMapSnapshot: (
    identifier: string,
    latitude: number,
    longitude: number,
    width: number,
    appearance: "light" | "dark",
  ) => Promise<string>;
  cancelLocationMapSnapshot: (identifier: string) => Promise<void>;
};

const nativeModule = requireOptionalNativeModule<SnapshotModule>("T3NativeControls");
const snapshots =
  typeof nativeModule?.createLocationMapSnapshot === "function" &&
  typeof nativeModule.cancelLocationMapSnapshot === "function"
    ? nativeModule
    : null;

export function LocationMapPreview({ location, appearance }: LocationMapPreviewProps) {
  const [width, setWidth] = useState(0);
  return (
    <View
      accessible={false}
      style={{ height: 160 }}
      className="relative overflow-hidden rounded-xl bg-subtle"
      onLayout={(event) => setWidth(Math.round(event.nativeEvent.layout.width))}
    >
      {width > 0 ? (
        <MapSnapshotImage
          key={`${location.latitude}:${location.longitude}:${width}:${appearance}`}
          location={location}
          appearance={appearance}
          width={width}
        />
      ) : (
        <MapStatus status="loading" />
      )}
    </View>
  );
}

function MapSnapshotImage({
  location,
  appearance,
  width,
}: LocationMapPreviewProps & { width: number }) {
  const [uri, setUri] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    snapshots ? "loading" : "error",
  );

  useEffect(() => {
    if (!snapshots) return;
    const identifier = uuidv4();
    let cancelled = false;
    void snapshots
      .createLocationMapSnapshot(
        identifier,
        location.latitude,
        location.longitude,
        width,
        appearance,
      )
      .then(
        (uri) => {
          if (!cancelled) setUri(uri);
        },
        () => {
          if (!cancelled) setStatus("error");
        },
      );
    return () => {
      cancelled = true;
      void snapshots.cancelLocationMapSnapshot(identifier).catch(() => {});
    };
  }, [appearance, location.latitude, location.longitude, width]);

  return (
    <>
      {uri ? (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="none"
          accessible={false}
          onDisplay={() => setStatus("ready")}
          onError={() => setStatus("error")}
        />
      ) : null}
      {status !== "ready" ? <MapStatus status={status} /> : null}
    </>
  );
}

function MapStatus({ status }: { status: "loading" | "error" }) {
  return (
    <View style={StyleSheet.absoluteFill} className="items-center justify-center bg-subtle">
      <AppText className="text-xs text-foreground-secondary">
        {status === "loading" ? "Loading map…" : "Map preview unavailable"}
      </AppText>
    </View>
  );
}
