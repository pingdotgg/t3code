import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { isElectron } from "../env";
import { useI18n } from "../i18n/I18nProvider";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function NoActiveThreadState() {
  const { t } = useI18n();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50">{t("emptyThread.status")}</span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                {t("emptyThread.status")}
              </span>
            </div>
          )}
        </WorkspacePageHeader>

        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-xl">{t("emptyThread.title")}</EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                {t("emptyThread.description")}
              </EmptyDescription>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
