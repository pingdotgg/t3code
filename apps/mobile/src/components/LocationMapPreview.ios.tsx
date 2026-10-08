import { useState, type ComponentType } from "react";
import { View, type ViewProps } from "react-native";
import { requireNativeView, requireOptionalNativeModule } from "expo";

import { AppText } from "./AppText";
import type { LocationMapPreviewProps } from "./LocationMapPreview.types";

type NativeMapProps = ViewProps & {
  readonly latitude: number;
  readonly longitude: number;
  readonly appearance: "light" | "dark";
  readonly onStatusChange: (event: {
    nativeEvent: { status: "loading" | "ready" | "error" };
  }) => void;
};

const NativeMap = loadNativeMap();

function loadNativeMap(): ComponentType<NativeMapProps> | null {
  try {
    const module = requireOptionalNativeModule<{
      readonly ViewPrototypes?: { readonly T3NativeControls_LocationMap?: unknown };
    }>("T3NativeControls");
    if (!module?.ViewPrototypes?.T3NativeControls_LocationMap) return null;
    return requireNativeView<NativeMapProps>("T3NativeControls", "LocationMap");
  } catch {
    return null;
  }
}

export function LocationMapPreview(props: LocationMapPreviewProps) {
  return (
    <MapPreview
      key={`${props.location.latitude}:${props.location.longitude}:${props.appearance}`}
      {...props}
    />
  );
}

function MapPreview({ location, appearance }: LocationMapPreviewProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    NativeMap ? "loading" : "error",
  );
  return (
    <View accessible={false} className="relative h-[160px] overflow-hidden rounded-xl bg-subtle">
      {NativeMap ? (
        <NativeMap
          style={{ width: "100%", height: "100%" }}
          latitude={location.latitude}
          longitude={location.longitude}
          appearance={appearance}
          onStatusChange={(event) => setStatus(event.nativeEvent.status)}
        />
      ) : null}
      {status !== "ready" ? (
        <View className="absolute inset-0 items-center justify-center bg-subtle">
          <AppText className="text-xs text-foreground-secondary">
            {status === "loading" ? "Loading map…" : "Map preview unavailable"}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}
