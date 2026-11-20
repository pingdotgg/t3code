import {
  secretRequestLink,
  secretRequestPrivacyNote,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import { ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { type FormEvent, useState } from "react";

import { answerSecret } from "../foryou/actions";
import { useEnvironmentThread } from "../state/threads";
import { ActionButton } from "./CardActions";
import type { EngineBodyProps } from "./engineBody";

const field =
  "w-full rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-fg outline-none placeholder:text-faint focus:border-muted";

/** A secret an agent asks for, which goes to the engine and never into a chat message. */
export function SecretBody({ target, card, request, sent, onError }: EngineBodyProps) {
  const [secret, setSecret] = useState("");
  const projection = Option.getOrNull(
    useEnvironmentThread(target.environmentId, ThreadId.make(request.threadId)).data,
  );
  const item = projection?.visibleTurnItems.find(
    (row): row is typeof row & { item: SecretRequestItem } =>
      row.item.type === "secret_request" && row.item.id === request.id,
  )?.item;
  if (item === undefined) {
    return (
      <p className="text-[11px] text-muted">
        {projection === null
          ? "Loading the request"
          : "This request is not a secret. Answer it in the agent's thread."}
      </p>
    );
  }
  const link = secretRequestLink(item);
  const send = (reply: Parameters<typeof answerSecret>[3]) => {
    onError(null);
    void answerSecret(target, card, item, reply).then(onError);
    setSecret("");
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    send({ type: "save", secret });
  };
  return (
    <form onSubmit={save} autoComplete="off" className="flex flex-col gap-2">
      <p className="text-[12px] font-semibold text-fg">{item.label}</p>
      {item.reason.trim() !== "" && (
        <p className="text-[11px] break-words text-muted">{item.reason}</p>
      )}
      {link !== null && (
        <a
          href={link.href}
          target="_blank"
          rel="noreferrer"
          onPointerDown={(event) => event.stopPropagation()}
          className="w-fit text-[11px] text-sky-300 hover:underline"
        >
          Open {link.host}
        </a>
      )}
      <input
        type="password"
        aria-label={item.label}
        value={secret}
        disabled={sent}
        onChange={(event) => setSecret(event.target.value)}
        onPointerDown={(event) => event.stopPropagation()}
        placeholder={item.placeholder ?? "Paste the secret"}
        className={field}
      />
      <p className="text-[10px] text-faint">{secretRequestPrivacyNote(item)}</p>
      <div className="flex gap-1.5">
        <ActionButton tone="primary" type="submit" disabled={sent || secret.trim() === ""}>
          Save
        </ActionButton>
        <ActionButton disabled={sent} onClick={() => send({ type: "decline" })}>
          Decline
        </ActionButton>
      </div>
    </form>
  );
}
