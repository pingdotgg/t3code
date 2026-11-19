import { useGT } from "gt-react";
import { MOBILE_APP_STORES } from "../../branding";
import { AndroidIcon, AppleIcon } from "../Icons";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { QRCodeSvg } from "../ui/qr-code";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const STORE_ICONS = { ios: AppleIcon, android: AndroidIcon };

export function MobileAppSettingsRow() {
  const setting = useSearchableSetting();
  const gt = useGT();
  if (MOBILE_APP_STORES.length === 0) return null;
  return (
    <SettingsRow
      {...setting("mobile-app")}
      description={gt("Connect to your server from your phone or tablet.")}
      control={
        <div className="flex items-center gap-2">
          {MOBILE_APP_STORES.map(({ platform, label, store, url }) => {
            const Icon = STORE_ICONS[platform];
            return (
              <Popover key={store}>
                <PopoverTrigger render={<Button size="sm" variant="outline" />}>
                  <Icon />
                  {label}
                </PopoverTrigger>
                <PopoverPopup align="end">
                  <div className="flex flex-col items-center gap-3">
                    <PopoverTitle>{store}</PopoverTitle>
                    <p className="text-xs text-muted-foreground">Scan with your phone camera.</p>
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
                      Open {store}
                    </Button>
                  </div>
                </PopoverPopup>
              </Popover>
            );
          })}
        </div>
      }
    />
  );
}
