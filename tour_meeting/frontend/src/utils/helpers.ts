import type { LogEntry, MessageOut } from "../types";
import { INVITATION_PHASE_TITLES } from "../constants";

// Key generation utilities
export const normalizeNameForKey = (name?: string | null) => {
  const replaced = (name ?? "").replace(/[\s\u3000<|\\/>\n\r\t]+/g, "_").replace(/^_+|_+$/g, "");
  return (replaced || "anon").slice(0, 64);
};

export const buildInternalKey = (turn: number | undefined, speaker: string) =>
  `${turn ?? 0}-${normalizeNameForKey(speaker)}`;

export const buildExpandedStorageKey = (meetingId?: string | null) => meetingId ?? "__global__";

// Log entry utilities
export const isMessageEntry = (entry: LogEntry): entry is MessageOut => entry.kind === "message";

export const findLastMessageEntry = (entries: LogEntry[]): MessageOut | null => {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (isMessageEntry(entries[i])) {
      return entries[i];
    }
  }
  return null;
};

export const countMessagesWithTurn = (entries: LogEntry[], turn: number): number =>
  entries.reduce((acc, entry) => (isMessageEntry(entry) && entry.turn === turn ? acc + 1 : acc), 0);

// Invitation message utilities
export const buildInvitationMessageEntry = (
  entries: LogEntry[],
  speaker: string,
  content: string,
  highlight: string,
): MessageOut => {
  const lastMessage = findLastMessageEntry(entries);
  const baseTurn = lastMessage?.turn ?? 1;
  const existingCount = countMessagesWithTurn(entries, baseTurn);
  const turnLabel = baseTurn ? `${baseTurn}-${existingCount + 1}` : undefined;
  return {
    kind: "message",
    name: speaker,
    content,
    turn: baseTurn,
    turnLabel,
    invitationHighlight: highlight,
  };
};

export const parseInvitationPhasePayload = (
  title: string,
  description?: string | null,
  fallbackSpeaker?: string,
): { speaker: string; reason: string; highlight: string } | null => {
  if (!INVITATION_PHASE_TITLES.has(title)) {
    return null;
  }
  const raw = (description ?? "").trim();
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const highlight = lines[0] || title;
  const reasonLine = lines.slice(1).find((line) => line.length > 0);
  const reason = reasonLine ? reasonLine.replace(/^Reason:\s*/i, "") : raw || highlight;
  const match = highlight.match(/^(.+?)\s+invited\s+(.+?)\s+to speak next\.?/i);
  // Normalize speaker name to match sanitized names in history (spaces→underscores)
  const rawSpeaker = match ? match[1].trim() : fallbackSpeaker || "System";
  const speaker = normalizeNameForKey(rawSpeaker);
  const nextSpeaker = match ? match[2].trim() : "";
  return { speaker, reason, highlight: nextSpeaker };
};
