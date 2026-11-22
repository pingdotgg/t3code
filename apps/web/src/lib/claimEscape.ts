/**
 * Keeps an Escape a widget consumed from also stopping the turn. The composer's editor
 * prevents every Escape, so a claim stops propagation as well.
 */
export function claimEscape(event: Event) {
  event.preventDefault();
  event.stopPropagation();
}
