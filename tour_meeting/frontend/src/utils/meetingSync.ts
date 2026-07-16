import type { MeetingInfo } from "../types";

/**
 * Helper to safely merge a string field
 */
const mergeString = <K extends keyof MeetingInfo>(
  data: Partial<MeetingInfo>,
  current: MeetingInfo,
  key: K
): MeetingInfo[K] =>
  typeof data[key] === "string" ? data[key] : current[key];

/**
 * Helper to safely merge a number field
 */
const mergeNumber = <K extends keyof MeetingInfo>(
  data: Partial<MeetingInfo>,
  current: MeetingInfo,
  key: K
): MeetingInfo[K] =>
  typeof data[key] === "number" ? data[key] : current[key];

/**
 * Merge meeting data from API response into existing meeting info.
 * Handles type checking and null preservation for each field type.
 */
export const mergeMeetingData = (
  current: MeetingInfo,
  data: Partial<MeetingInfo>
): MeetingInfo => ({
  ...current,
  title: data.title ?? current.title,
  include_human: data.include_human ?? current.include_human,
  human_name: typeof data.human_name === "string" ? data.human_name : current.human_name,
  human_avatar: data.human_avatar !== undefined ? data.human_avatar : current.human_avatar,
  human_role: typeof data.human_role === "string" ? data.human_role : current.human_role,
  has_history: data.has_history !== undefined ? Boolean(data.has_history) : current.has_history,
  status: mergeString(data, current, "status"),
  status_detail: data.status_detail !== undefined ? data.status_detail : current.status_detail,
  participant_count: mergeNumber(data, current, "participant_count"),
});
