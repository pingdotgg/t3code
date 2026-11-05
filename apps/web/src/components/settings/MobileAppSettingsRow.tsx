import { Trans } from "@palamedes/react/macro";
import { t } from "@palamedes/core/macro";
import { AndroidIcon, AppleIcon } from "../Icons";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { QRCodeSvg } from "../ui/qr-code";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const stores = [
  {
    get label() {
      return t({ message: "iPhone and iPad" });
    },
    store: "App Store",
    url: "https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824",
    Icon: AppleIcon,
  },
  {
    get label() {
      return t({ message: "Android" });
    },
    store: "Google Play",
    url: "https://play.google.com/store/apps/details?id=com.t3tools.t3code",
    Icon: AndroidIcon,
  },
];

export function MobileAppSettingsRow() {
  return (
    <SettingsRow
      {...searchableSetting("mobile-app")}
      description={t({ message: "Connect to your server from your phone or tablet." })}
      control={
        <div className="flex items-center gap-2">
          {stores.map(({ label, store, url, Icon }) => (
            <Popover key={store}>
              <PopoverTrigger render={<Button size="sm" variant="outline" />}>
                <Icon />
                {label}
              </PopoverTrigger>
              <PopoverPopup align="end">
                <div className="flex flex-col items-center gap-3">
                  <PopoverTitle>{store}</PopoverTitle>
                  <p className="text-xs text-muted-foreground">
                    <Trans>Scan with your phone camera.</Trans>
                  </p>
                  <div className="rounded-lg bg-white p-1.5">
                    <QRCodeSvg
                      value={url}
                      size={128}
                      level="M"
                      marginSize={1}
                      title={`${store} link`}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    render={<a href={url} target="_blank" rel="noreferrer noopener" />}
                  >
                    <Trans>Open {store}</Trans>
                  </Button>
                </div>
              </PopoverPopup>
            </Popover>
          ))}
        </div>
      }
    />
  );
}
