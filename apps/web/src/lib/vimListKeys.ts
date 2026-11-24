export function createVimListKeys() {
  let prefixTarget: EventTarget | null = null;
  return {
    reset() {
      prefixTarget = null;
    },
    read(event: KeyboardEvent, enabled: boolean) {
      const secondG = prefixTarget !== null && prefixTarget === event.target;
      prefixTarget = null;
      if (
        !enabled ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.keyCode === 229 ||
        (event.shiftKey && event.key !== "G")
      )
        return event.key;
      switch (event.key) {
        case "j":
          return "ArrowDown";
        case "k":
          return "ArrowUp";
        case "h":
          return "ArrowLeft";
        case "l":
          return "ArrowRight";
        case "G":
          return "End";
        case "g":
          if (secondG) return "Home";
          prefixTarget = event.target;
          return null;
        default:
          return event.key;
      }
    },
  };
}
