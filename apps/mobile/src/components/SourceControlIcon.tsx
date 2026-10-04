import Svg, { Circle, Defs, G, LinearGradient, Path, Stop } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedSvg = withUniwind(Svg);

export type SourceControlIconKind = "github" | "gitlab" | "forgejo" | "bitbucket" | "azure-devops";

export function SourceControlIcon(props: {
  readonly kind: SourceControlIconKind;
  readonly size?: number;
  readonly color?: string;
  readonly colorClassName?: string;
}) {
  const size = props.size ?? 18;

  switch (props.kind) {
    case "forgejo":
      // Official two-color mark from https://forgejo.org/favicon.svg.
      return (
        <Svg width={size} height={size} viewBox="0 0 212 212">
          <G transform="translate(6 6)" fill="none">
            <Path d="M58 168 v-98 a50 50 0 0 1 50-50 h20" stroke="#ff6600" strokeWidth={25} />
            <Path d="M58 168 v-30 a50 50 0 0 1 50-50 h20" stroke="#d40000" strokeWidth={25} />
            <Circle cx={142} cy={20} r={18} stroke="#ff6600" strokeWidth={15} />
            <Circle cx={142} cy={88} r={18} stroke="#d40000" strokeWidth={15} />
            <Circle cx={58} cy={180} r={18} stroke="#d40000" strokeWidth={15} />
          </G>
        </Svg>
      );
    case "github":
      return (
        <ThemedSvg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          color={props.color}
          colorClassName={props.colorClassName}
          fill="none"
        >
          <Path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.68 7.68 0 0 1 8.02 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
            fill="currentColor"
          />
        </ThemedSvg>
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
      // Microsoft Azure DevOps mark via selfhst/icons (CC BY 4.0): https://github.com/selfhst/icons/blob/main/svg/azure-devops.svg
      return (
        <Svg width={size} height={size} viewBox="0 0 512 512">
          <Defs>
            <LinearGradient
              id="azure-a"
              x1="58.027"
              x2="58.027"
              y1="356.668"
              y2="100.668"
              gradientTransform="matrix(1 0 0 -1 0 514)"
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset="0" stopColor="#163697" />
              <Stop offset=".276" stopColor="#2052cb" />
              <Stop offset=".518" stopColor="#2764e7" />
              <Stop offset=".879" stopColor="#367af2" />
            </LinearGradient>
            <LinearGradient
              id="azure-b"
              x1="58.027"
              x2="58.027"
              y1="351.334"
              y2="292.668"
              gradientTransform="matrix(1 0 0 -1 0 514)"
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset="0" stopColor="#102784" />
              <Stop offset="1" stopColor="#2052cb" stopOpacity="0" />
            </LinearGradient>
            <LinearGradient
              id="azure-c"
              x1="389.98"
              x2="107.314"
              y1="57.935"
              y2="193.935"
              gradientTransform="matrix(1 0 0 -1 0 514)"
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset="0" stopColor="#163697" />
              <Stop offset=".301" stopColor="#2052cb" />
              <Stop offset=".626" stopColor="#2764e7" />
              <Stop offset=".926" stopColor="#367af2" />
            </LinearGradient>
            <LinearGradient
              id="azure-d"
              x1="391.996"
              x2="341.385"
              y1="76.552"
              y2="78.224"
              gradientTransform="matrix(1 0 0 -1 0 514)"
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset="0" stopColor="#102784" />
              <Stop offset="1" stopColor="#2052cb" stopOpacity="0" />
            </LinearGradient>
            <LinearGradient
              id="azure-e"
              x1="442.24"
              x2="442.24"
              y1="54.769"
              y2="419.38"
              gradientTransform="matrix(1 0 0 -1 0 514)"
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset=".043" stopColor="#2052cb" />
              <Stop offset=".489" stopColor="#367af2" />
              <Stop offset=".943" stopColor="#16bbda" />
            </LinearGradient>
            <LinearGradient
              id="azure-f"
              x1="435.596"
              x2="425.732"
              y1="270.413"
              y2="385.266"
              gradientTransform="matrix(1 0 0 -1 0 514)"
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset=".134" stopColor="#16bbda" stopOpacity="0" />
              <Stop offset=".932" stopColor="#6be7a0" stopOpacity=".8629" />
            </LinearGradient>
            <LinearGradient
              id="azure-g"
              x1="437.081"
              x2="507.893"
              y1="204.362"
              y2="119.081"
              gradientTransform="matrix(1 0 0 -1 0 514)"
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset="0" stopColor="#2c68e0" stopOpacity="0" />
              <Stop offset=".898" stopColor="#66c0ff" stopOpacity=".5" />
            </LinearGradient>
            <LinearGradient
              id="azure-h"
              x1="99.399"
              x2="352.75"
              y1="279.26"
              y2="498.676"
              gradientTransform="matrix(1 0 0 -1 0 514)"
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset=".005" stopColor="#367af2" />
              <Stop offset=".507" stopColor="#0fafff" />
              <Stop offset="1" stopColor="#26cfe8" />
            </LinearGradient>
            <LinearGradient
              id="azure-i"
              x1="184.342"
              x2="338.581"
              y1="356.795"
              y2="480.642"
              gradientTransform="matrix(1 0 0 -1 0 514)"
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset=".443" stopColor="#26cfe8" stopOpacity="0" />
              <Stop offset=".897" stopColor="#6be7a0" stopOpacity=".8629" />
            </LinearGradient>
          </Defs>
          <Path
            d="M116.1 73.4c-5.8 5.8-13.7 13.8-13.7 22.6v216.4c0 8.9-3.3 17.3-9 23.4s-13.3 9.2-21.1 8.5l-42.7-3.1c-7.9-.5-15-3.9-20.3-9.3-5.7-5.7-9.3-13.7-9.3-22.6V202.7c0-8.9 3.6-16.9 9.4-22.6l2-1.9z"
            fill="url(#azure-a)"
          />
          <Path
            d="M116.1 73.4c-5.8 5.8-13.7 13.8-13.7 22.6v216.4c0 8.9-3.3 17.3-9 23.4s-13.3 9.2-21.1 8.5l-42.7-3.1c-7.9-.5-15-3.9-20.3-9.3-5.7-5.7-9.3-13.7-9.3-22.6V202.7c0-8.9 3.6-16.9 9.4-22.6l2-1.9z"
            fill="url(#azure-b)"
          />
          <Path
            d="m500.5 366-128 106.7c-5.5 4.6-12.7 7.4-20.5 7.4q-2.4 0-4.8-.3l-112.5-16.9v27.8c0 11.7-9.6 21.3-21.3 21.3-7.3 0-13.5-3.6-17.5-9.1l-36.2-51.4-5.4-7.6-36.6-51.9-7-10c-2.6-3.5-3.9-7.8-3.9-12.3 0-6 2.5-11.6 6.8-15.7 3.8-3.7 9.1-5.8 14.5-5.8.4 0 1 .1 1.5.1l105.2 7.5L384 366.5l93.7 6.7c.7.1 1.6.1 2.3.1 7.8 0 14.9-2.7 20.5-7.3"
            fill="url(#azure-c)"
          />
          <Path
            d="m500.5 366-128 106.7c-5.5 4.6-12.7 7.4-20.5 7.4q-2.4 0-4.8-.3l-112.5-16.9v27.8c0 11.7-9.6 21.3-21.3 21.3-7.3 0-13.5-3.6-17.5-9.1l-36.2-51.4-5.4-7.6-36.6-51.9-7-10c-2.6-3.5-3.9-7.8-3.9-12.3 0-6 2.5-11.6 6.8-15.7 3.8-3.7 9.1-5.8 14.5-5.8.4 0 1 .1 1.5.1l105.2 7.5L384 366.5l93.7 6.7c.7.1 1.6.1 2.3.1 7.8 0 14.9-2.7 20.5-7.3"
            fill="url(#azure-d)"
          />
          <Path
            d="M512 170.7v170.7c0 9.9-4.5 18.8-11.5 24.6l-128 106.7c7-5.9 11.5-14.7 11.5-24.6V175.3c0-16.7 13-30.7 29.8-31.9l63.9-4.6c.7-.1 1.6-.1 2.3-.1 7.8 0 14.9 2.8 20.5 7.4 7 5.8 11.5 14.6 11.5 24.6"
            fill="url(#azure-e)"
          />
          <Path
            d="M512 170.7v170.7c0 9.9-4.5 18.8-11.5 24.6l-128 106.7c7-5.9 11.5-14.7 11.5-24.6V175.3c0-16.7 13-30.7 29.8-31.9l63.9-4.6c.7-.1 1.6-.1 2.3-.1 7.8 0 14.9 2.8 20.5 7.4 7 5.8 11.5 14.6 11.5 24.6"
            fill="url(#azure-f)"
            fillOpacity=".7"
          />
          <Path
            d="M512 170.7v170.7c0 9.9-4.5 18.8-11.5 24.6l-128 106.7c7-5.9 11.5-14.7 11.5-24.6V175.3c0-16.7 13-30.7 29.8-31.9l63.9-4.6c.7-.1 1.6-.1 2.3-.1 7.8 0 14.9 2.8 20.5 7.4 7 5.8 11.5 14.6 11.5 24.6"
            fill="url(#azure-g)"
          />
          <Path
            d="M384 125.5c0 11.2-8.6 20.5-19.8 21.3-.5 0-1.1.1-1.6.1l-127.9 9.2-132.3 9.1-72.7 5.5c-6.9.4-13.2 3.1-18.2 7.4L116.1 73.4c4.7-4.7 10.9-8 17.8-9.1l100.8-15.1V21.3C234.7 9.6 244.3 0 256 0c5.8 0 11.1 2.3 14.9 6.1l33.4 32.6 16.9 16.5 40.3 39.3 16.1 15.8c4.1 3.9 6.4 9.4 6.4 15.2"
            fill="url(#azure-h)"
          />
          <Path
            d="M384 125.5c0 11.2-8.6 20.5-19.8 21.3-.5 0-1.1.1-1.6.1l-127.9 9.2-132.3 9.1-72.7 5.5c-6.9.4-13.2 3.1-18.2 7.4L116.1 73.4c4.7-4.7 10.9-8 17.8-9.1l100.8-15.1V21.3C234.7 9.6 244.3 0 256 0c5.8 0 11.1 2.3 14.9 6.1l33.4 32.6 16.9 16.5 40.3 39.3 16.1 15.8c4.1 3.9 6.4 9.4 6.4 15.2"
            fill="url(#azure-i)"
            fillOpacity=".5"
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
  }
}
