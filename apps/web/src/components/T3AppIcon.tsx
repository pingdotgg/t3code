// The production icon, as GitHub shows the T3 Code app, whatever this build's channel.
import upstreamAppIconUrl from "../../../../assets/prod/t3-black-web-apple-touch-180.png";
import standaloneAppIconUrl from "../../../../assets/easydev/easydev-web-apple-touch-180.png";
import { IS_STANDALONE_BUILD } from "~/projectLinks";

const appIconUrl = IS_STANDALONE_BUILD ? standaloneAppIconUrl : upstreamAppIconUrl;

export function T3AppIcon(props: { readonly className?: string }) {
  return <img src={appIconUrl} alt="" className={props.className} />;
}
