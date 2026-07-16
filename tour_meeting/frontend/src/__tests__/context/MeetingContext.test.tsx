import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import React from "react";
import {
  MeetingProvider,
  useMeetingContext,
  useMeetingSettings,
  useCurrentMeeting,
  useSettingsCache,
} from "../../context/MeetingContext";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <MeetingProvider>{children}</MeetingProvider>
);

describe("MeetingContext", () => {
  it("throws when used outside provider", () => {
    expect(() => renderHook(() => useMeetingContext())).toThrow(
      "useMeetingContext must be used within a MeetingProvider"
    );
  });

  it("initializes with current default settings", () => {
    const { result } = renderHook(() => useMeetingContext(), { wrapper });
    expect(result.current.settings.maxTurns).toBe(100);
    expect(result.current.settings.turnRule).toBe("round_robin");
    expect(result.current.settings.draftVotingRule).toBe("majority");
    expect(result.current.settings.volunteerMode).toBe(false);
    expect(result.current.settings.voteSettingsLinked).toBe(true);
  });

  it("updates and resets settings", () => {
    const { result } = renderHook(() => useMeetingContext(), { wrapper });
    act(() => {
      result.current.updateSettings({
        maxTurns: 25,
        timeLimit: "30",
        voteTurnRule: "random",
        voteSettingsLinked: false,
      });
    });
    expect(result.current.settings.maxTurns).toBe(25);
    expect(result.current.settings.timeLimit).toBe("30");
    expect(result.current.settings.voteTurnRule).toBe("random");
    expect(result.current.settings.voteSettingsLinked).toBe(false);

    act(() => result.current.resetSettings());
    expect(result.current.settings.maxTurns).toBe(100);
    expect(result.current.settings.timeLimit).toBe("");
    expect(result.current.settings.voteTurnRule).toBe("round_robin");
    expect(result.current.settings.voteSettingsLinked).toBe(true);
  });

  it("manages current meeting id", () => {
    const { result } = renderHook(() => useMeetingContext(), { wrapper });
    expect(result.current.currentMeetingId).toBeNull();
    act(() => result.current.setCurrentMeetingId("meeting-1"));
    expect(result.current.currentMeetingId).toBe("meeting-1");
  });

  it("creates and updates settings cache entries", () => {
    const { result } = renderHook(() => useMeetingContext(), { wrapper });
    const created = result.current.getSettingsCache("meeting-1");
    expect(created.maxTurns).toBe(100);
    expect(created.turnRule).toBe("round_robin");
    expect(created.votingRule).toBe("majority");

    act(() => {
      result.current.updateSettingsCache("meeting-1", {
        maxTurns: 60,
        turnRule: "inviting",
        votingRule: "most_pleasure",
        voteSettingsLinked: false,
      });
    });
    const updated = result.current.getSettingsCache("meeting-1");
    expect(updated.maxTurns).toBe(60);
    expect(updated.turnRule).toBe("inviting");
    expect(updated.votingRule).toBe("most_pleasure");
    expect(updated.voteSettingsLinked).toBe(false);
  });

  it("loads settings from cache", () => {
    const { result } = renderHook(() => useMeetingContext(), { wrapper });
    act(() => {
      result.current.updateSettingsCache("meeting-1", {
        maxTurns: 50,
        timeLimit: "60",
        turnRule: "facilitating",
        votingRule: "least_misery",
        globalGoals: "goal",
      });
      result.current.loadSettingsFromCache("meeting-1");
    });

    expect(result.current.settings.maxTurns).toBe(50);
    expect(result.current.settings.timeLimit).toBe("60");
    expect(result.current.settings.turnRule).toBe("facilitating");
    expect(result.current.settings.draftVotingRule).toBe("least_misery");
    expect(result.current.settings.globalGoals).toBe("goal");
  });

  it("saves current settings to cache", () => {
    const { result } = renderHook(() => useMeetingContext(), { wrapper });
    act(() => {
      result.current.updateSettings({
        maxTurns: 30,
        turnRule: "random",
        draftVotingRule: "single_decider",
        globalGoals: "Test goal",
      });
    });
    act(() => {
      result.current.saveSettingsToCache("meeting-1");
    });
    const cache = result.current.getSettingsCache("meeting-1");
    expect(cache.maxTurns).toBe(30);
    expect(cache.turnRule).toBe("random");
    expect(cache.votingRule).toBe("single_decider");
    expect(cache.globalGoals).toBe("Test goal");
  });

  it("exposes convenience hooks", () => {
    const s = renderHook(() => useMeetingSettings(), { wrapper });
    expect(s.result.current.maxTurns).toBe(100);
    expect(s.result.current.updateSetting).toBeDefined();

    const m = renderHook(() => useCurrentMeeting(), { wrapper });
    expect(m.result.current.currentMeetingId).toBeNull();

    const c = renderHook(() => useSettingsCache(), { wrapper });
    expect(c.result.current.getSettingsCache).toBeDefined();
    expect(c.result.current.saveSettingsToCache).toBeDefined();
  });
});
