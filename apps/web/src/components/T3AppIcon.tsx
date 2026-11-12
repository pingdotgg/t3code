// The production icon, as GitHub shows the T3 Code app, whatever this build's channel.
import appIconUrl from "../../../../assets/prod/t3-black-web-apple-touch-180.png";

export function T3AppIcon(props: { readonly className?: string }) {
  return <img src={appIconUrl} alt="" className={props.className} />;
}
