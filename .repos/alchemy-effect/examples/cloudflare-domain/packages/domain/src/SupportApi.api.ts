import * as Domain from "@alchemy.run/domain";
import { Bank } from "./Bank.model.ts";

/** What the support console reaches, over the same Bank. */
export class SupportApi extends Domain.Api("SupportApi", {
  model: Bank,
  commands: ["FreezeAccount", "ChangeOwner", "ApproveTransfer"],
  views: ["AccountSummary", "AccountActivity"],
  streams: [],
  aggregates: [],
}) {}
