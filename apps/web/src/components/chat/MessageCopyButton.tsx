import { memo, useCallback, useState } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Button } from "../ui/button";

export const MessageCopyButton = memo(function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <Button type="button" size="xs" variant="outline" onClick={handleCopy} title="Copy message">
      {copied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </Button>
  );
});
