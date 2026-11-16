import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/** The boxd.sh mark. */
export function BoxdIcon(props: { readonly size: number; readonly colorClassName: string }) {
  return (
    <Svg accessibilityLabel="boxd" width={props.size} height={props.size} viewBox="0 0 24 24">
      <ThemedPath
        d="M2 0H22A2 2 0 0 1 24 2V22A2 2 0 0 1 22 24H6.8A2 2 0 0 1 4.8 22V21.2A2 2 0 0 0 2.8 19.2H2A2 2 0 0 1 0 17.2V2A2 2 0 0 1 2 0Z"
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
