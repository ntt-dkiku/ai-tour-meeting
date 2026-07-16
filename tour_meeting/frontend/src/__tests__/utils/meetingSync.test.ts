import { describe, it, expect } from "vitest";
import { mergeMeetingData } from "../../utils/meetingSync";
import type { MeetingInfo } from "../../types";

describe("meetingSync utilities", () => {
  const baseMeeting: MeetingInfo = {
    id: "meeting-1",
    title: "Original Title",
    created_at: "2024-01-01T00:00:00Z",
    participant_count: 3,
    has_history: false,
    include_human: false,
    status: "idle",
    status_detail: "Ready to start",
    travel_date: null,
    time_window_start: null,
    time_window_end: null,
    budget: null,
  };

  describe("mergeMeetingData", () => {
    it("merges title and keeps untouched fields", () => {
      const result = mergeMeetingData(baseMeeting, { title: "Updated Title" });
      expect(result.title).toBe("Updated Title");
      expect(result.id).toBe(baseMeeting.id);
      expect(result.participant_count).toBe(baseMeeting.participant_count);
    });

    it("updates status only when incoming value is string", () => {
      const result = mergeMeetingData(baseMeeting, { status: "running" });
      expect(result.status).toBe("running");

      const unchanged = mergeMeetingData(baseMeeting, { status: 123 as unknown as string });
      expect(unchanged.status).toBe("idle");
    });

    it("updates participant_count only when incoming value is number", () => {
      const result = mergeMeetingData(baseMeeting, { participant_count: 10 });
      expect(result.participant_count).toBe(10);

      const unchanged = mergeMeetingData(baseMeeting, { participant_count: "x" as unknown as number });
      expect(unchanged.participant_count).toBe(3);
    });

    it("handles nullable status_detail", () => {
      const withText = mergeMeetingData(baseMeeting, { status_detail: "Processing" });
      expect(withText.status_detail).toBe("Processing");

      const withNull = mergeMeetingData(baseMeeting, { status_detail: null });
      expect(withNull.status_detail).toBeNull();
    });

    it("converts has_history to boolean when provided", () => {
      const result = mergeMeetingData(baseMeeting, { has_history: 1 as unknown as boolean });
      expect(result.has_history).toBe(true);
    });

    it("handles include_human via nullish coalescing", () => {
      const included = mergeMeetingData(baseMeeting, { include_human: true });
      expect(included.include_human).toBe(true);

      const unchanged = mergeMeetingData(baseMeeting, { include_human: undefined });
      expect(unchanged.include_human).toBe(false);
    });

    it("does not mutate original object", () => {
      const original = { ...baseMeeting };
      mergeMeetingData(baseMeeting, { title: "Changed" });
      expect(baseMeeting).toEqual(original);
    });
  });
});
