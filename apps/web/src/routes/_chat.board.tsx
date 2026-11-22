import { createFileRoute } from "@tanstack/react-router";

import { boardSearchFromUrl } from "../trail/board/boardSearch.logic";
import { TrailBoardPage } from "../trail/board/TrailBoardPage";

export const Route = createFileRoute("/_chat/board")({
  validateSearch: boardSearchFromUrl,
  component: TrailBoardPage,
});
