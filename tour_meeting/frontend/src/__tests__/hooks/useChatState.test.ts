import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChatState } from "../../hooks/useChatState";

describe("useChatState", () => {
  it("should initialize with default values", () => {
    const { result } = renderHook(() => useChatState());

    expect(result.current.logs).toEqual([]);
    expect(result.current.connected).toBe(false);
    expect(result.current.status).toBe("idle");
    expect(result.current.userMessage).toBe("");
    expect(result.current.needModification).toBe(false);
    expect(result.current.waitingForUser).toBe(false);
    expect(result.current.waitingForVote).toBe(false);
    expect(result.current.votingData).toBeNull();
    expect(result.current.expandedInternalLogs).toEqual({});
    expect(result.current.expandedObservations).toEqual({});
  });

  it("should update logs", () => {
    const { result } = renderHook(() => useChatState());

    act(() => {
      result.current.setLogs([
        { kind: "message", name: "Alice", content: "Hello", turn: 1 },
      ]);
    });

    expect(result.current.logs).toHaveLength(1);
    expect(result.current.logs[0]).toMatchObject({
      kind: "message",
      name: "Alice",
    });
  });

  it("should update connected status", () => {
    const { result } = renderHook(() => useChatState());

    act(() => {
      result.current.setConnected(true);
    });

    expect(result.current.connected).toBe(true);
  });

  it("should update meeting status", () => {
    const { result } = renderHook(() => useChatState());

    act(() => {
      result.current.setStatus("running");
    });

    expect(result.current.status).toBe("running");
  });

  it("should update user message", () => {
    const { result } = renderHook(() => useChatState());

    act(() => {
      result.current.setUserMessage("Test message");
    });

    expect(result.current.userMessage).toBe("Test message");
  });

  it("should update waiting states", () => {
    const { result } = renderHook(() => useChatState());

    act(() => {
      result.current.setWaitingForUser(true);
      result.current.setWaitingForVote(true);
    });

    expect(result.current.waitingForUser).toBe(true);
    expect(result.current.waitingForVote).toBe(true);
  });

  it("should update voting data", () => {
    const { result } = renderHook(() => useChatState());
    const votingData = { options: ["A", "B", "C"] };

    act(() => {
      result.current.setVotingData(votingData);
    });

    expect(result.current.votingData).toEqual(votingData);
  });

  it("should update expanded internal logs", () => {
    const { result } = renderHook(() => useChatState());

    act(() => {
      result.current.setExpandedInternalLogs({ "1-Alice": true });
    });

    expect(result.current.expandedInternalLogs).toEqual({ "1-Alice": true });
  });

  it("should reset chat state", () => {
    const { result } = renderHook(() => useChatState());

    // Set various states
    act(() => {
      result.current.setLogs([
        { kind: "message", name: "Alice", content: "Hello", turn: 1 },
      ]);
      result.current.setConnected(true);
      result.current.setStatus("running");
      result.current.setUserMessage("Test");
      result.current.setWaitingForUser(true);
      result.current.setExpandedInternalLogs({ key: true });
    });

    // Reset
    act(() => {
      result.current.resetChatState();
    });

    // Verify all states are reset
    expect(result.current.logs).toEqual([]);
    expect(result.current.connected).toBe(false);
    expect(result.current.status).toBe("idle");
    expect(result.current.userMessage).toBe("");
    expect(result.current.waitingForUser).toBe(false);
    expect(result.current.expandedInternalLogs).toEqual({});
  });

  it("should initialize vote selections with defaults", () => {
    const { result } = renderHook(() => useChatState());

    expect(result.current.consensusVoteSelections).toEqual({
      approved: [],
      rejected: [],
      scores: [],
      message: "",
    });

    expect(result.current.routeVoteSelections).toEqual({
      accept: null,
      score: null,
      message: "",
    });
  });

  it("should update consensus vote selections", () => {
    const { result } = renderHook(() => useChatState());

    act(() => {
      result.current.setConsensusVoteSelections({
        approved: [1, 2],
        rejected: [3],
        scores: [{ modification_id: 1, score: 5 }],
        message: "Looks good",
      });
    });

    expect(result.current.consensusVoteSelections.approved).toEqual([1, 2]);
    expect(result.current.consensusVoteSelections.message).toBe("Looks good");
  });

  it("should update route vote selections", () => {
    const { result } = renderHook(() => useChatState());

    act(() => {
      result.current.setRouteVoteSelections({
        accept: true,
        score: null,
        message: "Prefer this route",
      });
    });

    expect(result.current.routeVoteSelections.accept).toBe(true);
    expect(result.current.routeVoteSelections.message).toBe("Prefer this route");
  });

  it("should provide wsRef", () => {
    const { result } = renderHook(() => useChatState());

    expect(result.current.wsRef).toBeDefined();
    expect(result.current.wsRef.current).toBeNull();
  });
});
