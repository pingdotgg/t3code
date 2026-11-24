import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

vi.mock("../../cloud/publicConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cloud/publicConfig")>()),
  hasCloudPublicConfig: () => true,
}));
vi.mock("./T3ConnectAccountPages", () => ({ T3_CONNECT_ACCOUNT_PAGES: [] }));
vi.mock("@clerk/react", async (importOriginal) => {
  const UserButton = Object.assign(({ children }: { children: ReactNode }) => children, {
    UserProfilePage: () => null,
    __experimental_Outlet: () => <div className="h-40 w-80">Manage account</div>,
  });
  return {
    ...(await importOriginal<typeof import("@clerk/react")>()),
    UserButton,
    useAuth: () => ({ isLoaded: true, isSignedIn: true }),
    useUser: () => ({
      isLoaded: true,
      isSignedIn: true,
      user: { imageUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" },
    }),
  };
});

const { T3ConnectSidebarAvatar } = await import("./T3ConnectSidebarSignIn");

it("opens the account menu above the bottom-left avatar, extending right", async () => {
  await using screen = await render(
    <div className="fixed bottom-0 left-0 flex flex-col p-3">
      <T3ConnectSidebarAvatar />
    </div>,
  );
  const trigger = screen.getByRole("button", { name: "Account menu" });
  await userEvent.click(trigger);
  const menu = page.getByText("Manage account");
  await expect.element(menu).toBeVisible();

  const triggerRect = trigger.element().getBoundingClientRect();
  const menuRect = menu.element().getBoundingClientRect();
  expect(menuRect.bottom).toBeLessThanOrEqual(triggerRect.top);
  expect(Math.abs(menuRect.left - triggerRect.left)).toBeLessThanOrEqual(1);
  expect(menuRect.right).toBeGreaterThan(triggerRect.right);
});
