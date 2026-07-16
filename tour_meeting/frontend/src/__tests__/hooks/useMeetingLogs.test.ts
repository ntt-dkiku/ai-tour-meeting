import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMeetingLogs } from "../../hooks/useMeetingLogs";
import type { LogEntry, MessageOut, MeetingHistory } from "../../types";
import { INTERNAL_EXPANDED_STORAGE_KEY } from "../../constants";

describe("useMeetingLogs", () => {
  const createOptions = (overrides: { logs?: LogEntry[] } & Record<string, unknown> = {}) => {
    const logs: LogEntry[] = overrides.logs ?? [];
    const setLogs = vi.fn((updater: ((prev: LogEntry[]) => LogEntry[]) | LogEntry[]) => {
      if (typeof updater === "function") {
        const newLogs = updater(logs);
        logs.length = 0;
        logs.push(...newLogs);
      }
    });

    const meetingHistory: MeetingHistory = {};
    const setMeetingHistory = vi.fn();

    const expandedInternalLogs: Record<string, boolean> = {};
    const setExpandedInternalLogs = vi.fn((updater: ((prev: Record<string, boolean>) => Record<string, boolean>) | Record<string, boolean>) => {
      if (typeof updater === "function") {
        const result = updater(expandedInternalLogs);
        Object.keys(expandedInternalLogs).forEach(k => delete expandedInternalLogs[k]);
        Object.assign(expandedInternalLogs, result);
      }
    });

    return {
      currentMeetingId: "meeting-123",
      logs,
      setLogs,
      meetingHistory,
      setMeetingHistory,
      expandedInternalLogs,
      setExpandedInternalLogs,
      meetings: [] as { id: string; status?: string }[],
      status: "idle",
      ...overrides,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("should initialize with default values", () => {
    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    expect(result.current.elapsedSeconds).toBe(0);
    expect(result.current.expandedInternalLogsCache).toEqual({});
  });

  it("should call setLogs when upserting a new message", () => {
    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.upsertMessage(1, "Alice", undefined, "Hello, world!");
    });

    expect(options.setLogs).toHaveBeenCalled();
    // Verify the updater function creates the correct entry
    const updater = options.setLogs.mock.calls[0][0];
    const newLogs = updater([]);
    expect(newLogs).toHaveLength(1);
    expect(newLogs[0]).toMatchObject({
      kind: "message",
      turn: 1,
      name: "Alice",
      content: "Hello, world!",
    });
  });

  it("should append to existing message via updater", () => {
    const existingMessage: MessageOut = {
      kind: "message",
      turn: 1,
      name: "Alice",
      content: "Hello",
    };
    const options = createOptions({ logs: [existingMessage] });
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.upsertMessage(1, "Alice", ", world!");
    });

    expect(options.setLogs).toHaveBeenCalled();
    // Verify the updater appends correctly
    const updater = options.setLogs.mock.calls[0][0];
    const newLogs = updater([existingMessage]);
    expect(newLogs[0]).toMatchObject({
      content: "Hello, world!",
    });
  });

  it("should update message with final text via updater", () => {
    const existingMessage: MessageOut = {
      kind: "message",
      turn: 1,
      name: "Alice",
      content: "Streaming...",
    };
    const options = createOptions({ logs: [existingMessage] });
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.upsertMessage(1, "Alice", undefined, "Final content");
    });

    expect(options.setLogs).toHaveBeenCalled();
    const updater = options.setLogs.mock.calls[0][0];
    const newLogs = updater([existingMessage]);
    expect(newLogs[0]).toMatchObject({
      content: "Final content",
    });
  });

  it("should upsert route plan via updater", () => {
    const existingMessage: MessageOut = {
      kind: "message",
      turn: 1,
      name: "Alice",
      content: "Here is my plan",
    };
    const options = createOptions({ logs: [existingMessage] });
    const routePlan = { route: ["A", "B", "C"] };
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.upsertRoutePlan(1, "Alice", routePlan);
    });

    expect(options.setLogs).toHaveBeenCalled();
    const updater = options.setLogs.mock.calls[0][0];
    const newLogs = updater([existingMessage]);
    expect((newLogs[0] as MessageOut).routePlan).toEqual(routePlan);
  });

  it("should not upsert route plan for non-existent message", () => {
    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.upsertRoutePlan(1, "Alice", { route: ["A"] });
    });

    expect(options.setLogs).toHaveBeenCalled();
    // Verify updater returns unchanged array when message not found
    const updater = options.setLogs.mock.calls[0][0];
    const newLogs = updater([]);
    expect(newLogs).toHaveLength(0);
  });

  it("should append phase log", () => {
    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.appendPhaseLog("Discussion Phase", "Starting the discussion");
    });

    expect(options.setLogs).toHaveBeenCalled();
    const updater = options.setLogs.mock.calls[0][0];
    const newLogs = updater([]);
    expect(newLogs).toHaveLength(1);
    expect(newLogs[0]).toMatchObject({
      kind: "phase",
      title: "Discussion Phase",
      description: "Starting the discussion",
    });
  });

  it("skips a replayed phase log when the same marker is already shown", () => {
    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.appendPhaseLog("Tour Meeting Started", "Let's plan!", { replay: true });
    });

    const updater = options.setLogs.mock.calls[0][0];
    const existing: LogEntry[] = [
      { kind: "phase", title: "Tour Meeting Started", description: "Let's plan!" },
    ];
    const newLogs = updater(existing);
    expect(newLogs).toBe(existing);
    expect(newLogs).toHaveLength(1);
  });

  it("still appends a replayed phase log when it is not yet shown", () => {
    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.appendPhaseLog("Consensus Reached", undefined, { replay: true });
    });

    const updater = options.setLogs.mock.calls[0][0];
    const newLogs = updater([
      { kind: "phase", title: "Tour Meeting Started", description: "Let's plan!" },
    ]);
    expect(newLogs).toHaveLength(2);
    expect(newLogs[1]).toMatchObject({ kind: "phase", title: "Consensus Reached" });
  });

  it("appends duplicate phase logs when not replayed", () => {
    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.appendPhaseLog("Proposal Skipped", "Too few destinations.");
    });

    const updater = options.setLogs.mock.calls[0][0];
    const newLogs = updater([
      { kind: "phase", title: "Proposal Skipped", description: "Too few destinations." },
    ]);
    expect(newLogs).toHaveLength(2);
  });

  it("should toggle internal log expansion", () => {
    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    const key = "1-Alice";

    // Clear any calls from useEffect during mount
    options.setExpandedInternalLogs.mockClear();

    act(() => {
      result.current.toggleInternalLog(key);
    });

    expect(options.setExpandedInternalLogs).toHaveBeenCalled();

    // Find the call with an updater function (not the object from useEffect)
    const calls = options.setExpandedInternalLogs.mock.calls;
    const updaterCall = calls.find(call => typeof call[0] === "function");
    expect(updaterCall).toBeDefined();

    const updater = updaterCall![0] as (prev: Record<string, boolean>) => Record<string, boolean>;

    // Test toggle on -> off
    const result1 = updater({});
    expect(result1[key]).toBe(true);

    // Test toggle off -> on
    const result2 = updater({ [key]: true });
    expect(result2[key]).toBe(false);
  });

  it("should reset logs state", () => {
    const existingMessage: MessageOut = {
      kind: "message",
      turn: 1,
      name: "Alice",
      content: "Hello",
    };
    const options = createOptions({ logs: [existingMessage] });
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.resetLogsState();
    });

    expect(options.setLogs).toHaveBeenCalledWith([]);
  });

  it("should handle internal event with thinking step", () => {
    const existingMessage: MessageOut = {
      kind: "message",
      turn: 1,
      name: "Alice",
      content: "Thinking...",
    };
    const options = createOptions({ logs: [existingMessage] });
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.handleInternalEvent(1, "Alice", {
        event_type: "thinking_step",
        thought: "Let me analyze this",
        step_number: 1,
        max_steps: 5,
        action: "analyze",
      });
    });

    // The internal event triggers upsertMessage which calls setLogs
    expect(options.setLogs).toHaveBeenCalled();
    const updater = options.setLogs.mock.calls[0][0];
    const newLogs = updater([existingMessage]);
    expect((newLogs[0] as MessageOut).stepsLog).toContain("Let me analyze this");
    expect((newLogs[0] as MessageOut).stepsLog).toContain("[Step 1/5 - analyze]");
  });

  it("should handle internal event completion", () => {
    const existingMessage: MessageOut = {
      kind: "message",
      turn: 1,
      name: "Alice",
      content: "Done",
      stepsLog: "Thinking...",
    };
    const options = createOptions({ logs: [existingMessage] });
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.handleInternalEvent(1, "Alice", {
        event_type: "complete",
        task_label: "Research",
      });
    });

    expect(options.setLogs).toHaveBeenCalled();
    const updater = options.setLogs.mock.calls[0][0];
    const newLogs = updater([existingMessage]);
    expect((newLogs[0] as MessageOut).stepsLabel).toBe("Research");
  });

  it("should not call setLogs for undefined internal event", () => {
    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.handleInternalEvent(1, "Alice", undefined);
    });

    expect(options.setLogs).not.toHaveBeenCalled();
  });

  it("should restore expanded logs for meeting", () => {
    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    // Set up cache
    act(() => {
      result.current.setExpandedInternalLogsCache({
        "expanded-meeting-456": { "key1": true, "key2": false },
      });
    });

    act(() => {
      result.current.restoreExpandedLogs("meeting-456");
    });

    expect(options.setExpandedInternalLogs).toHaveBeenCalled();
  });

  it("should tick elapsed time", () => {
    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    // Set a start time
    const now = Math.floor(Date.now() / 1000);
    result.current.meetingStartRef.current["meeting-123"] = now - 10;

    act(() => {
      result.current.tickElapsed();
    });

    expect(result.current.elapsedSeconds).toBeGreaterThanOrEqual(10);
  });

  it("should use resume offset when no start time", () => {
    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    result.current.meetingResumeOffsetRef.current["meeting-123"] = 60;

    act(() => {
      result.current.tickElapsed();
    });

    expect(result.current.elapsedSeconds).toBe(60);
  });

  it("should not tick when currentMeetingId is null", () => {
    const options = createOptions({ currentMeetingId: null });
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.tickElapsed();
    });

    expect(result.current.elapsedSeconds).toBe(0);
  });

  it("should update meeting history when logs change", () => {
    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.upsertMessage(1, "Alice", undefined, "Message content");
    });

    expect(options.setMeetingHistory).toHaveBeenCalled();
  });

  it("should handle message with internal context", () => {
    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.upsertMessage(1, "Alice", undefined, "Response", undefined, {
        log: "Internal thoughts",
        taskLabel: "Analysis",
      });
    });

    expect(options.setLogs).toHaveBeenCalled();
    const updater = options.setLogs.mock.calls[0][0];
    const newLogs = updater([]);
    expect(newLogs[0]).toMatchObject({
      stepsLog: "Internal thoughts",
      stepsLabel: "Analysis",
    });
  });

  it("should add route plan to new message", () => {
    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    const routePlan = { route: ["Location A", "Location B"] };

    act(() => {
      result.current.upsertMessage(1, "Alice", undefined, "Here's the plan", routePlan);
    });

    expect(options.setLogs).toHaveBeenCalled();
    const updater = options.setLogs.mock.calls[0][0];
    const newLogs = updater([]);
    expect((newLogs[0] as MessageOut).routePlan).toEqual(routePlan);
  });

  it("should load expanded logs cache from localStorage on mount", () => {
    const cache = { "expanded-meeting-123": { "key1": true } };
    localStorage.setItem(INTERNAL_EXPANDED_STORAGE_KEY, JSON.stringify(cache));

    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    // useEffect runs after render, cache should be loaded
    expect(result.current.expandedInternalLogsCache).toEqual(cache);
  });

  it("should save expanded logs cache to localStorage", async () => {
    const options = createOptions();
    const { result } = renderHook(() => useMeetingLogs(options));

    act(() => {
      result.current.setExpandedInternalLogsCache({
        "expanded-meeting-123": { "key1": true },
      });
    });

    // Wait for effect
    await vi.waitFor(() => {
      expect(localStorage.setItem).toHaveBeenCalledWith(
        INTERNAL_EXPANDED_STORAGE_KEY,
        expect.any(String)
      );
    });
  });
});
