import type { MessageOut } from "../types";

// Time formatting
export const formatElapsed = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
};

// Parse a "HH:MM" clock string into minutes since midnight (null if invalid).
export const parseClockToMinutes = (value?: string | null): number | null => {
  if (!value) return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || m >= 60) return null;
  return h * 60 + m;
};

// Parse a stay-duration string ("120 min", "1.5 hours", "1 hour") into minutes.
export const parseDurationToMinutes = (value?: string | null): number | null => {
  if (!value) return null;
  const lowered = value.toLowerCase();
  let minutes = 0;
  let matched = false;
  const hourMatch = lowered.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hour|hours)\b/);
  if (hourMatch) {
    minutes += parseFloat(hourMatch[1]) * 60;
    matched = true;
  }
  const minMatch = lowered.match(/(\d+(?:\.\d+)?)\s*(?:m|min|minute|minutes)\b/);
  if (minMatch) {
    minutes += parseFloat(minMatch[1]);
    matched = true;
  }
  if (!matched) return null;
  return Math.round(minutes);
};

const formatClock = (totalMinutes: number): string => {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

// Build a "HH:MM - HH:MM" stay window from an arrival time and a stay duration.
// Returns null when either input is missing/unparseable or the stay is empty,
// so callers can fall back to the raw duration text.
export const formatStayWindow = (
  startTime?: string | null,
  stayDuration?: string | null
): string | null => {
  const start = parseClockToMinutes(startTime);
  const duration = parseDurationToMinutes(stayDuration);
  if (start === null || duration === null || duration <= 0) return null;
  return `${formatClock(start)} - ${formatClock(start + duration)}`;
};

// Content formatting
export const getDisplayContent = (entry: MessageOut): string => {
  return entry.content || "";
};
