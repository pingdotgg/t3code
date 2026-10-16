import { useState } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import type { FrostedCutoutProps } from "./FrostedCutout.types";

export function FrostedCutout(props: FrostedCutoutProps) {
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const x = (width - props.cutoutWidth) / 2;
  const y = props.cutoutTop;
  const w = props.cutoutWidth;
  const h = props.cutoutHeight;
  const r = Math.min(props.cutoutRadius, w / 2, h / 2);
  const hole = `M${x + r},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} V${y + h - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} H${x + r} A${r},${r} 0 0 1 ${x},${y + h - r} V${y + r} A${r},${r} 0 0 1 ${x + r},${y} Z`;

  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      onLayout={(event) => {
        setWidth(event.nativeEvent.layout.width);
        setHeight(event.nativeEvent.layout.height);
      }}
    >
      {width > 0 ? (
        <Svg height={height} width={width}>
          <Path
            d={`M0,0 H${width} V${height} H0 Z ${hole}`}
            fill={props.appearance === "light" ? "#ffffff" : "#000000"}
            fillOpacity={0.55}
            fillRule="evenodd"
          />
        </Svg>
      ) : null}
    </View>
  );
}
