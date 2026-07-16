/** Normalize a stored human name ("" / null → the default "You"). */
export const normalizeHumanName = (name?: string | null): string => {
  const trimmed = (name || "").trim();
  return trimmed || "You";
};

/** GUI label for the human participant: the plain name backend-side, with a
 *  "(You)" suffix in the UI so the human is recognizable at a glance. The
 *  default name "You" is shown as-is (no "You (You)"). */
export const humanDisplayLabel = (name?: string | null): string => {
  const n = normalizeHumanName(name);
  return n === "You" ? "You" : `${n} (You)`;
};
