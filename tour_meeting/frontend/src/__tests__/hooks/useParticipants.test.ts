import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useParticipants } from "../../hooks/useParticipants";
import type { ParticipantIn } from "../../types";

const mockParticipant: ParticipantIn = {
  model_name: "gpt-4",
  temperature: 0.7,
  seed: 42,
  max_tokens: null,
  max_context_length: null,
  context_mode: "auto_compact",
  auto_compact_threshold: 0.8,
  auto_compact_target: 0.5,
  compact_recent_ratio: 0.7,
  fixed_turns_count: 10,
  name: "Alice",
  background: "A friendly traveler",
  personality: "Curious and sociable",
  preferences: "Enjoys local food and hidden gems",
  personal_goals: "Find good restaurants",
  role: "participant",
  speaking_style: "friendly",
  explanation_style: "auto",
  web_search: true,
  max_steps: 5,
};

describe("useParticipants", () => {
  const apiBase = "http://localhost:8080";
  const currentMeetingId = "meeting-123";

  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
  });

  it("should initialize with empty participants", () => {
    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId })
    );

    expect(result.current.participants).toEqual([]);
    expect(result.current.order).toEqual([]);
    expect(result.current.includeHuman).toBe(false);
  });

  it("should refresh participants from API", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([mockParticipant]),
    });

    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId })
    );

    await act(async () => {
      await result.current.refreshParticipants();
    });

    expect(result.current.participants).toEqual([mockParticipant]);
    expect(global.fetch).toHaveBeenCalledWith(
      `${apiBase}/meetings/${currentMeetingId}/participants`
    );
  });

  it("should not refresh when currentMeetingId is null", async () => {
    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId: null })
    );

    await act(async () => {
      await result.current.refreshParticipants();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should handle refresh error gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Network error")
    );

    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId })
    );

    await act(async () => {
      await result.current.refreshParticipants();
    });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("should delete a participant", async () => {
    // Setup: first load participants
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([mockParticipant]),
      })
      // DELETE request
      .mockResolvedValueOnce({ ok: true })
      // Refresh after delete
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId })
    );

    await act(async () => {
      await result.current.refreshParticipants();
    });

    await act(async () => {
      await result.current.deleteParticipant("Alice");
    });

    expect(global.fetch).toHaveBeenCalledWith(
      `${apiBase}/meetings/${currentMeetingId}/participants/Alice`,
      { method: "DELETE" }
    );
  });

  it("should add a participant", async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      // POST request
      .mockResolvedValueOnce({ ok: true })
      // Refresh after add
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([mockParticipant]),
      });

    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId })
    );

    // Set form data
    act(() => {
      result.current.setForm(mockParticipant);
    });

    await act(async () => {
      await result.current.addParticipant();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      `${apiBase}/meetings/${currentMeetingId}/participants`,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  it("saves a form without required fields as an incomplete draft", async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      // POST request
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, id: "abc123" }),
      })
      // Refresh after add
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId })
    );

    // Form is empty by default → stored as a "No name" incomplete draft
    await act(async () => {
      await result.current.addParticipant();
    });

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${apiBase}/meetings/${currentMeetingId}/participants`);
    const body = JSON.parse(init.body);
    expect(body.incomplete).toBe(true);
    expect(body.name).toBe("");
  });

  it("should open and close modal", () => {
    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId })
    );

    expect(result.current.showModal).toBe(false);

    act(() => {
      result.current.openAddModal();
    });
    expect(result.current.showModal).toBe(true);

    act(() => {
      result.current.closeModal();
    });
    expect(result.current.showModal).toBe(false);
  });

  it("should open edit modal with participant data", () => {
    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId })
    );

    act(() => {
      result.current.openEditParticipant(mockParticipant, 0);
    });

    expect(result.current.showModal).toBe(true);
    expect(result.current.editingParticipant).toEqual({
      index: 0,
      data: mockParticipant,
    });
    expect(result.current.form).toEqual(mockParticipant);
  });

  it("should update include human setting", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
    });

    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId })
    );

    await act(async () => {
      await result.current.updateIncludeHuman(true);
    });

    expect(result.current.includeHuman).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      `${apiBase}/meetings/${currentMeetingId}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ include_human: true }),
      })
    );
  });

  it("keeps includeHuman unchanged when the update request fails", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId })
    );

    await act(async () => {
      await result.current.updateIncludeHuman(true);
    });

    expect(result.current.includeHuman).toBe(false);
  });

  it("should handle drag over participants", () => {
    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId })
    );

    const mockEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.DragEvent;

    act(() => {
      result.current.handleParticipantsDragOver(mockEvent);
    });

    expect(result.current.isDragOverParticipants).toBe(true);
    expect(mockEvent.preventDefault).toHaveBeenCalled();
  });

  it("should handle drag leave participants", () => {
    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId })
    );

    const mockEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.DragEvent;

    // First set to true
    act(() => {
      result.current.handleParticipantsDragOver(mockEvent);
    });
    expect(result.current.isDragOverParticipants).toBe(true);

    // Then leave
    act(() => {
      result.current.handleParticipantsDragLeave(mockEvent);
    });
    expect(result.current.isDragOverParticipants).toBe(false);
  });

  it("should remove all participants", async () => {
    // Setup with two participants
    const participants = [
      mockParticipant,
      { ...mockParticipant, name: "Bob" },
    ];

    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(participants),
      })
      // Two DELETE requests
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });

    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId })
    );

    await act(async () => {
      await result.current.refreshParticipants();
    });

    expect(result.current.participants.length).toBe(2);

    await act(async () => {
      await result.current.removeAllParticipants();
    });

    expect(result.current.participants).toEqual([]);
  });

  it("should handle participant error on add failure", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ detail: "Participant already exists" }),
    });

    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId })
    );

    act(() => {
      result.current.setForm(mockParticipant);
    });

    await act(async () => {
      await result.current.addParticipant();
    });

    expect(result.current.participantError).toBe("Participant already exists");
  });

  it("should validate participant data from API", async () => {
    // API returns invalid data with missing name
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          { ...mockParticipant, name: null },
          mockParticipant,
        ]),
    });

    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId })
    );

    await act(async () => {
      await result.current.refreshParticipants();
    });

    // Should convert null name to empty string
    expect(result.current.participants[0].name).toBe("");
    expect(result.current.participants[1].name).toBe("Alice");
  });

  it("should update order when participants change", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          mockParticipant,
          { ...mockParticipant, name: "Bob" },
        ]),
    });

    const { result } = renderHook(() =>
      useParticipants({ apiBase, currentMeetingId })
    );

    await act(async () => {
      await result.current.refreshParticipants();
    });

    await waitFor(() => {
      expect(result.current.order).toContain("Alice");
      expect(result.current.order).toContain("Bob");
    });
  });
});
