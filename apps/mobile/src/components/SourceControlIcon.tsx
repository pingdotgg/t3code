import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";

export type SourceControlIconKind = "github" | "gitlab" | "bitbucket" | "azure-devops" | "forgejo";

export function SourceControlIcon(props: {
  readonly kind: SourceControlIconKind;
  readonly size?: number;
  readonly color?: string;
}) {
  const size = props.size ?? 18;

  switch (props.kind) {
    case "github":
      return (
        <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <Path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.68 7.68 0 0 1 8.02 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
            fill={props.color ?? "#24292F"}
          />
        </Svg>
      );
    case "gitlab":
      return (
        <Svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <Path
            d="m31.46 12.78-.04-.12-4.35-11.35A1.14 1.14 0 0 0 25.94.6c-.24 0-.47.1-.66.24-.19.15-.33.36-.39.6l-2.94 9h-11.9l-2.94-9A1.14 1.14 0 0 0 6.07.58a1.15 1.15 0 0 0-1.14.72L.58 12.68l-.05.11a8.1 8.1 0 0 0 2.68 9.34l.02.01.04.03 6.63 4.97 3.28 2.48 2 1.52a1.35 1.35 0 0 0 1.62 0l2-1.52 3.28-2.48 6.67-5h.02a8.09 8.09 0 0 0 2.7-9.36Z"
            fill="#E24329"
          />
          <Path
            d="m31.46 12.78-.04-.12a14.75 14.75 0 0 0-5.86 2.64l-9.55 7.24 6.09 4.6 6.67-5h.02a8.09 8.09 0 0 0 2.67-9.36Z"
            fill="#FC6D26"
          />
          <Path
            d="m9.9 27.14 3.28 2.48 2 1.52a1.35 1.35 0 0 0 1.62 0l2-1.52 3.28-2.48-6.1-4.6-6.07 4.6Z"
            fill="#FCA326"
          />
          <Path
            d="M6.44 15.3a14.71 14.71 0 0 0-5.86-2.63l-.05.12a8.1 8.1 0 0 0 2.68 9.34l.02.01.04.03 6.63 4.97 6.1-4.6-9.56-7.24Z"
            fill="#FC6D26"
          />
        </Svg>
      );
    case "azure-devops":
      return (
        <Svg width={size} height={size} viewBox="0 0 96 96">
          <Defs>
            <LinearGradient id="azure-a" x1="42.83" x2="15.79" y1="12.69" y2="92.57">
              <Stop offset="0" stopColor="#114A8B" />
              <Stop offset="1" stopColor="#0669BC" />
            </LinearGradient>
            <LinearGradient id="azure-b" x1="47.84" x2="77.52" y1="10.36" y2="89.44">
              <Stop offset="0" stopColor="#3CCBF4" />
              <Stop offset="1" stopColor="#2892DF" />
            </LinearGradient>
          </Defs>
          <Path
            fill="url(#azure-a)"
            d="M33.34 6.54h26.04l-27.03 80.1a4.15 4.15 0 0 1-3.94 2.81H8.15a4.14 4.14 0 0 1-3.93-5.47L29.4 9.38a4.15 4.15 0 0 1 3.94-2.83z"
          />
          <Path
            fill="#0078D4"
            d="M71.17 60.26H29.88a1.91 1.91 0 0 0-1.3 3.31l26.53 24.76a4.17 4.17 0 0 0 2.85 1.13h23.38z"
          />
          <Path
            fill="url(#azure-b)"
            d="M66.6 9.36a4.14 4.14 0 0 0-3.93-2.82H33.65a4.15 4.15 0 0 1 3.93 2.82l25.18 74.62a4.15 4.15 0 0 1-3.93 5.48h29.02a4.15 4.15 0 0 0 3.93-5.48z"
          />
        </Svg>
      );
    case "bitbucket":
      return (
        <Svg width={size} height={size} viewBox="8.4 14.39 2481.29 2231.21">
          <Defs>
            <LinearGradient
              id="bitbucket-a"
              x1="945.1094"
              y1="1524.8389"
              x2="944.4923"
              y2="1524.1893"
              gradientTransform="matrix(1996.6343 0 0 -1480.3047 -1884485.625 2258195)"
            >
              <Stop offset="0.18" stopColor="#0052CC" />
              <Stop offset="1" stopColor="#2684FF" />
            </LinearGradient>
          </Defs>
          <Path
            fill="#2684FF"
            d="M88.92,14.4C45.02,13.83,8.97,48.96,8.41,92.86c-0.06,4.61,0.28,9.22,1.02,13.77l337.48,2048.72 c8.68,51.75,53.26,89.8,105.74,90.24h1619.03c39.38,0.5,73.19-27.9,79.49-66.78l337.49-2071.78c7.03-43.34-22.41-84.17-65.75-91.2 c-4.55-0.74-9.15-1.08-13.76-1.02L88.92,14.4z M1509.99,1495.09H993.24l-139.92-731h781.89L1509.99,1495.09z"
          />
          <Path
            fill="url(#bitbucket-a)"
            d="M2379.27,763.06h-745.5l-125.12,730.42H992.31l-609.67,723.67c19.32,16.71,43.96,26,69.5,26.21h1618.13 c39.35,0.51,73.14-27.88,79.44-66.72L2379.27,763.06z"
          />
        </Svg>
      );
    case "forgejo":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d="M7 7.2v9.6"
            stroke={props.color ?? "#FB923C"}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
          <Path
            d="M17 7.2C17 12 12 11 9.2 12.5"
            stroke={props.color ?? "#FB923C"}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </Svg>
      );
  }
}
