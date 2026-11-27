import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogFooter,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./alert-dialog";
import { Button } from "./button";

describe("AlertDialogFooter", () => {
  it("keeps buttons inside the popup when their labels are wider than one row", async () => {
    await page.viewport(1280, 800);
    await using _screen = await render(
      <AlertDialog open>
        <AlertDialogPopup>
          <AlertDialogTitle>Editar a partir daqui?</AlertDialogTitle>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancelar</AlertDialogClose>
            <Button variant="destructive-outline">Reverter repositórios também</Button>
            <Button>Reverter e manter as alterações</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>,
    );

    await expect.element(page.getByRole("button", { name: "Cancelar" })).toBeVisible();
    const popup = page.getByRole("alertdialog").element().getBoundingClientRect();
    for (const button of page.getByRole("button").elements()) {
      const rect = button.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(popup.left);
      expect(rect.right).toBeLessThanOrEqual(popup.right);
    }
  });
});
