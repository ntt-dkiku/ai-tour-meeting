import { useState, useCallback, useEffect } from "react";
import type { Avatar, ParticipantIn } from "../types";
import { createDefaultParticipantForm } from "../constants";
import { YOU_ID as DND_YOU_ID } from "../components/DnDParticipants";

// Participants are keyed by their server-assigned id; the name is display-only
// (duplicates allowed). The name fallback covers not-yet-refreshed rows.
export const participantKey = (p: ParticipantIn) => p.id ?? p.name;

// The participant modal auto-fills these as soon as it opens (avatar seed,
// model token/temperature defaults), so they don't count as user edits when
// deciding whether a closed form should be kept as a draft.
const AUTO_FILLED_FIELDS = new Set(["avatar", "temperature", "max_tokens", "max_context_length"]);

interface UseParticipantsOptions {
  apiBase: string;
  currentMeetingId: string | null;
}

export interface UseParticipantsReturn {
  // State
  participants: ParticipantIn[];
  setParticipants: React.Dispatch<React.SetStateAction<ParticipantIn[]>>;
  order: string[];
  setOrder: React.Dispatch<React.SetStateAction<string[]>>;
  includeHuman: boolean;
  setIncludeHuman: React.Dispatch<React.SetStateAction<boolean>>;
  humanName: string;
  setHumanName: React.Dispatch<React.SetStateAction<string>>;
  humanAvatar: Avatar | null;
  setHumanAvatar: React.Dispatch<React.SetStateAction<Avatar | null>>;
  humanRole: string;
  setHumanRole: React.Dispatch<React.SetStateAction<string>>;
  form: ParticipantIn;
  setForm: React.Dispatch<React.SetStateAction<ParticipantIn>>;
  editingParticipant: { index: number; data: ParticipantIn } | null;
  setEditingParticipant: React.Dispatch<React.SetStateAction<{ index: number; data: ParticipantIn } | null>>;
  participantError: string;
  setParticipantError: React.Dispatch<React.SetStateAction<string>>;
  showModal: boolean;
  setShowModal: React.Dispatch<React.SetStateAction<boolean>>;
  isDragOverParticipants: boolean;
  setIsDragOverParticipants: React.Dispatch<React.SetStateAction<boolean>>;

  // Actions
  refreshParticipants: () => Promise<void>;
  addParticipant: () => Promise<void>;
  deleteParticipant: (participantId: string) => Promise<void>;
  duplicateParticipant: (participantId: string) => Promise<void>;
  removeAllParticipants: () => Promise<void>;
  downloadParticipants: () => Promise<void>;
  openEditParticipant: (participant: ParticipantIn, index: number) => void;
  updateIncludeHuman: (include: boolean) => Promise<void>;
  /** Persist the human participant's name/icon/role. Returns an error message, or null on success. */
  updateHumanProfile: (name: string, avatar: Avatar | null, role: string) => Promise<string | null>;
  handleParticipantsDragOver: (e: React.DragEvent) => void;
  handleParticipantsDragLeave: (e: React.DragEvent) => void;
  handleParticipantsDrop: (e: React.DragEvent) => Promise<void>;
  closeModal: () => void;
  openAddModal: () => void;
}

export function useParticipants({
  apiBase,
  currentMeetingId,
}: UseParticipantsOptions): UseParticipantsReturn {
  const [participants, setParticipants] = useState<ParticipantIn[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [includeHuman, setIncludeHuman] = useState<boolean>(false);
  const [humanName, setHumanName] = useState<string>("You");
  const [humanAvatar, setHumanAvatar] = useState<Avatar | null>(null);
  const [humanRole, setHumanRole] = useState<string>("attendee");
  const [form, setForm] = useState<ParticipantIn>(() => createDefaultParticipantForm());
  const [editingParticipant, setEditingParticipant] = useState<{ index: number; data: ParticipantIn } | null>(null);
  const [participantError, setParticipantError] = useState<string>("");
  const [showModal, setShowModal] = useState<boolean>(false);
  const [isDragOverParticipants, setIsDragOverParticipants] = useState(false);

  // Refresh participants from API
  const refreshParticipants = useCallback(async () => {
    if (!currentMeetingId) return;
    try {
      const res = await fetch(`${apiBase}/meetings/${currentMeetingId}/participants`);
      if (!res.ok) {
        throw new Error("Failed to load participants");
      }
      const data = await res.json();
      const validatedData = Array.isArray(data)
        ? data.map((p: any) => ({
            ...p,
            name: typeof p.name === "string" ? p.name : "",
            max_steps:
              typeof p.max_steps === "number" && Number.isFinite(p.max_steps) && p.max_steps > 0
                ? Math.floor(p.max_steps)
                : 5,
          }))
        : [];
      setParticipants(validatedData);
    } catch (err) {
      console.error("Failed to load participants:", err);
    }
  }, [apiBase, currentMeetingId]);

  // Delete a participant (by id; names are not identifiers)
  const deleteParticipant = useCallback(async (participantId: string) => {
    if (!currentMeetingId) return;
    try {
      const response = await fetch(
        `${apiBase}/meetings/${currentMeetingId}/participants/${encodeURIComponent(participantId)}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        throw new Error("Failed to delete participant");
      }
      await refreshParticipants();
    } catch (err) {
      console.error("Failed to delete participant:", err);
    }
  }, [apiBase, currentMeetingId, refreshParticipants]);

  // Duplicate a participant (the copy is inserted right after the original)
  const duplicateParticipant = useCallback(async (participantId: string) => {
    if (!currentMeetingId) return;
    try {
      const response = await fetch(
        `${apiBase}/meetings/${currentMeetingId}/participants/${encodeURIComponent(participantId)}/duplicate`,
        { method: "POST" }
      );
      if (!response.ok) {
        throw new Error("Failed to duplicate participant");
      }
      await refreshParticipants();
    } catch (err) {
      console.error("Failed to duplicate participant:", err);
    }
  }, [apiBase, currentMeetingId, refreshParticipants]);

  // Remove all participants
  const removeAllParticipants = useCallback(async () => {
    if (!currentMeetingId || participants.length === 0) return;
    try {
      for (const participant of participants) {
        await fetch(
          `${apiBase}/meetings/${currentMeetingId}/participants/${encodeURIComponent(participantKey(participant))}`,
          { method: "DELETE" }
        );
      }
      setParticipants([]);
    } catch (err) {
      console.error("Failed to remove all participants:", err);
    }
  }, [apiBase, currentMeetingId, participants]);

  // Add or update a participant. Sending the id of an existing participant
  // updates it in place on the server (order position preserved). A form with
  // missing fields — including a blank name — is saved as an incomplete draft.
  const addParticipant = useCallback(async () => {
    if (!currentMeetingId) return;

    const isComplete = !!(
      form.name.trim() &&
      form.background.trim() &&
      form.personality.trim() &&
      form.preferences.trim() &&
      form.personal_goals.trim()
    );

    setParticipantError("");

    try {
      const payload: ParticipantIn = {
        id: editingParticipant?.data.id ?? form.id,
        incomplete: !isComplete,
        avatar: form.avatar ?? null,
        model_name: form.model_name,
        temperature: Number(form.temperature),
        seed: Number.isFinite(Number(form.seed)) ? Number(form.seed) : 42,
        max_tokens: form.max_tokens ?? undefined,
        max_context_length: form.max_context_length ?? undefined,
        context_mode: form.context_mode,
        auto_compact_threshold: form.auto_compact_threshold,
        auto_compact_target: form.auto_compact_target,
        fixed_turns_count: form.fixed_turns_count,
        compact_recent_ratio: form.compact_recent_ratio,
        name: form.name,
        background: form.background,
        personality: form.personality,
        preferences: form.preferences,
        personal_goals: form.personal_goals,
        role: form.role,
        speaking_style: form.speaking_style,
        explanation_style: form.explanation_style,
        web_search: form.web_search,
        max_steps:
          Number.isFinite(Number(form.max_steps)) && Number(form.max_steps) > 0
            ? Math.floor(Number(form.max_steps))
            : 5,
        // Send null when blank so the backend uses the default system prompt.
        system_prompt: form.system_prompt && form.system_prompt.trim() ? form.system_prompt : null,
      };

      const response = await fetch(`${apiBase}/meetings/${currentMeetingId}/participants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error("Failed to add participant:", errorData);
        setParticipantError(errorData.detail || "Failed to add participant. Please try again.");
        return;
      }

      await refreshParticipants();
      setForm(createDefaultParticipantForm());
      setEditingParticipant(null);
      setShowModal(false);
      setParticipantError("");
    } catch (err) {
      console.error("Error in addParticipant:", err);
      setParticipantError("An unexpected error occurred. Please try again.");
    }
  }, [apiBase, currentMeetingId, form, editingParticipant, refreshParticipants]);

  // Download participants as JSON
  const downloadParticipants = useCallback(async () => {
    if (!currentMeetingId) return;
    try {
      const res = await fetch(`${apiBase}/meetings/${currentMeetingId}/participants`);
      if (!res.ok) {
        throw new Error("Failed to fetch participants");
      }
      const data = await res.json();
      const exportData = { participants: data };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `participants_${currentMeetingId}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to download participants:", err);
    }
  }, [apiBase, currentMeetingId]);

  // Open edit modal
  const openEditParticipant = useCallback((participant: ParticipantIn, index: number) => {
    setEditingParticipant({ index, data: participant });
    setForm(participant);
    setParticipantError("");
    setShowModal(true);
  }, []);

  // Open add modal with a fresh form.
  const openAddModal = useCallback(() => {
    setForm(createDefaultParticipantForm());
    setParticipantError("");
    setShowModal(true);
  }, []);

  // Close modal (overlay click or × button). Any edited form is saved — a
  // complete one becomes a live participant, a partial one (even without a
  // name) becomes an incomplete "No name" draft. Only a pristine, untouched
  // add-form is discarded so open-then-close doesn't litter draft cards.
  const closeModal = useCallback(() => {
    const defaults = createDefaultParticipantForm() as Record<string, unknown>;
    const current = form as unknown as Record<string, unknown>;
    const touched = Object.keys(defaults).some(
      (k) =>
        !AUTO_FILLED_FIELDS.has(k) &&
        JSON.stringify(current[k]) !== JSON.stringify(defaults[k])
    );
    const untouched = !editingParticipant && !touched;
    if (!untouched) {
      // addParticipant() persists the participant (complete or draft) and, on
      // success, resets the form and closes the modal (on failure it keeps the
      // modal open with an error), so we return without discarding the input.
      void addParticipant();
      return;
    }
    setShowModal(false);
    setEditingParticipant(null);
    setForm(createDefaultParticipantForm());
    setParticipantError("");
  }, [form, editingParticipant, addParticipant]);

  // Update include human setting
  const updateIncludeHuman = useCallback(async (include: boolean) => {
    if (!currentMeetingId) {
      setIncludeHuman(include);
      return;
    }
    try {
      const res = await fetch(`${apiBase}/meetings/${currentMeetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ include_human: include }),
      });
      if (!res.ok) {
        throw new Error(`PATCH failed with status ${res.status}`);
      }
      setIncludeHuman(include);
    } catch (err) {
      console.error("Failed to update include_human:", err);
    }
  }, [apiBase, currentMeetingId]);

  // Persist the human participant's name, icon and role.
  const updateHumanProfile = useCallback(
    async (name: string, avatar: Avatar | null, role: string): Promise<string | null> => {
      if (!currentMeetingId) {
        setHumanName(name);
        setHumanAvatar(avatar);
        setHumanRole(role);
        return null;
      }
      try {
        const res = await fetch(`${apiBase}/meetings/${currentMeetingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ human_name: name, human_avatar: avatar, human_role: role }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          return (
            (data && typeof data.detail === "string" && data.detail) ||
            `Failed to update your profile (status ${res.status})`
          );
        }
        setHumanName(name);
        setHumanAvatar(avatar);
        setHumanRole(role);
        return null;
      } catch (err) {
        console.error("Failed to update human profile:", err);
        return "Failed to update your profile";
      }
    },
    [apiBase, currentMeetingId]
  );

  // Drag and drop handlers
  const handleParticipantsDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOverParticipants(true);
  }, []);

  const handleParticipantsDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOverParticipants(false);
  }, []);

  const handleParticipantsDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOverParticipants(false);
    if (!currentMeetingId) return;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    if (file.type !== "application/json" && !file.name.endsWith(".json")) {
      return;
    }

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.participants || !Array.isArray(data.participants)) {
        console.error("Invalid participants file format");
        return;
      }

      await fetch(`${apiBase}/meetings/${currentMeetingId}/participants/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participants: data.participants }),
      });

      await refreshParticipants();
    } catch (err) {
      console.error("Failed to import participants:", err);
    }
  }, [apiBase, currentMeetingId, refreshParticipants]);

  // Update order when participants or includeHuman changes.
  useEffect(() => {
    setOrder((prevOrder) => {
      const ids = new Set(participants.map(participantKey));
      if (includeHuman) {
        ids.add(DND_YOU_ID);
      } else {
        ids.delete(DND_YOU_ID);
      }
      const next = prevOrder.filter((x) => ids.has(x));
      participants.forEach((p) => {
        if (!next.includes(participantKey(p))) next.push(participantKey(p));
      });
      if (includeHuman && !next.includes(DND_YOU_ID)) next.push(DND_YOU_ID);
      return next;
    });
  }, [participants, includeHuman]);

  return {
    participants,
    setParticipants,
    order,
    setOrder,
    includeHuman,
    setIncludeHuman,
    humanName,
    setHumanName,
    humanAvatar,
    setHumanAvatar,
    humanRole,
    setHumanRole,
    form,
    setForm,
    editingParticipant,
    setEditingParticipant,
    participantError,
    setParticipantError,
    showModal,
    setShowModal,
    isDragOverParticipants,
    setIsDragOverParticipants,
    refreshParticipants,
    addParticipant,
    deleteParticipant,
    duplicateParticipant,
    removeAllParticipants,
    downloadParticipants,
    openEditParticipant,
    updateIncludeHuman,
    updateHumanProfile,
    handleParticipantsDragOver,
    handleParticipantsDragLeave,
    handleParticipantsDrop,
    closeModal,
    openAddModal,
  };
}
