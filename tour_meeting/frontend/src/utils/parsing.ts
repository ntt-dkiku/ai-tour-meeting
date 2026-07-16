/**
 * Parsing utility functions for meeting settings
 */

/**
 * Parse a string as a positive integer
 * Returns null if the string is empty or not a valid positive integer
 */
export const parsePositiveInt = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
};

/**
 * Parse a string as a numeric value
 * Returns null if the string is empty or not a valid number
 */
export const parseNumeric = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Convert a value to a number with a fallback
 */
export const toNumber = (value: unknown, fallback: number): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

/**
 * Clamp a value between 0 and 1
 */
export const clamp01 = (value: number): number =>
  Math.min(1, Math.max(0, value));

/**
 * Check if a meeting status indicates it's active (running or stopping)
 */
export const isActiveStatus = (status: string): boolean =>
  status === "running" || status === "stopping";
