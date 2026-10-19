import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../../ui/toast";
import { readableFailure } from "../pullRequestDetail.logic";
import { guideRunKey, useGuideRunStore } from "./guideRunStore";

export function useReviewGuideWriter({
  environmentId,
  reference,
  title,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  title: string | null;
}) {
  const query = useEnvironmentQuery(
    pullRequestEnvironment.reviewGuide({ environmentId, input: reference }),
  );
  const canWrite = useAtomValue(
    pullRequestEnvironment.generateReviewGuide.permissionAtom(environmentId),
  );
  const generate = useAtomCommand(pullRequestEnvironment.generateReviewGuide, {
    reportFailure: false,
  });
  const [starting, setStarting] = useState(false);
  const data = query.data;
  const running = starting || data?.run?._tag === "Running";

  const watchRun = useEffectEvent(() =>
    useGuideRunStore.getState().watch({
      environmentId,
      reference,
      title,
      previousGuideAt: data?.guide?.generatedAt ?? null,
      previousFailedAt: data?.run?._tag === "Failed" ? data.run.failedAt : null,
      since: Date.now(),
    }),
  );
  useEffect(() => {
    if (data?.run?._tag === "Running") watchRun();
  }, [data?.run?._tag]);

  const write = async () => {
    if (running) return;
    setStarting(true);
    watchRun();
    const result = await generate({ environmentId, input: reference });
    setStarting(false);
    if (result._tag === "Failure") {
      useGuideRunStore.getState().settle(guideRunKey(environmentId, reference));
      toastManager.add({
        type: "error",
        title: "Could not start a review guide",
        description: readableFailure(
          squashAtomCommandFailure(result),
          "Check the review guide model in Settings → Source Control.",
        ),
      });
    }
  };

  return { query, data, running, canWrite, write };
}
