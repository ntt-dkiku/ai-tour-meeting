import React from "react";
import { AlertTriangle, Download, Trash2, UploadCloud } from "lucide-react";
import DnDParticipants from "../DnDParticipants";
import type { Avatar, ParticipantIn, ParticipantMenuState } from "../../types";

interface ParticipantsSectionProps {
  participants: ParticipantIn[];
  order: string[];
  setOrder: (order: string[]) => void;
  includeHuman: boolean;
  updateIncludeHuman: (include: boolean) => void;
  humanName: string;
  humanAvatar: Avatar | null;
  humanRole: string;
  /** Opens the human name/icon editor (fired right after Add You is checked, and from the card's ... menu). */
  onEditHuman: () => void;
  /** Opens the "..." menu (Edit / Delete) on the human card. */
  onHumanMenuOpen?: (rect: DOMRect) => void;
  /** Whether more than one facilitator is currently assigned (blocks Start). */
  tooManyFacilitators?: boolean;
  currentMeetingId: string | null;
  connected: boolean;
  settingsLocked: boolean;
  apiBase: string;
  isDragOverParticipants: boolean;
  onAddParticipant: () => void;
  onDownloadParticipants: () => void;
  onRemoveAllParticipants: () => void;
  onParticipantsDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onParticipantsDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onParticipantsDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  showParticipantMenu?: (participantName: string, rect: DOMRect) => void;
  onViewParticipant?: (participantId: string) => void;
}

const ParticipantsSection: React.FC<ParticipantsSectionProps> = ({
  participants,
  order,
  setOrder,
  includeHuman,
  updateIncludeHuman,
  humanName,
  humanAvatar,
  humanRole,
  onEditHuman,
  onHumanMenuOpen,
  tooManyFacilitators,
  currentMeetingId,
  connected,
  settingsLocked,
  apiBase,
  isDragOverParticipants,
  onAddParticipant,
  onDownloadParticipants,
  onRemoveAllParticipants,
  onParticipantsDragOver,
  onParticipantsDragLeave,
  onParticipantsDrop,
  showParticipantMenu,
  onViewParticipant,
}) => {
  return (
    <div className="mb-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-semibold text-on-surface-secondary">
            Participants ({participants.length + (includeHuman ? 1 : 0)})
          </h3>
          {tooManyFacilitators && (
            <span
              className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
              role="alert"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              More than one facilitator — only one is allowed
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <label className="inline-flex items-center gap-2 px-2.5 py-2.5 rounded-lg border border-outline bg-surface text-sm text-on-surface-secondary shadow-sm">
            <input
              type="checkbox"
              className="rounded text-accent focus:ring-accent"
              checked={includeHuman}
              onChange={(e) => {
                const include = e.target.checked;
                updateIncludeHuman(include);
                // Adding yourself immediately offers the name/icon editor.
                if (include) onEditHuman();
              }}
              disabled={!currentMeetingId || connected || settingsLocked}
            />
            <span>Add You</span>
          </label>
          <button
            onClick={onAddParticipant}
            disabled={settingsLocked}
            className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
              settingsLocked
                ? "bg-accent-soft text-white cursor-not-allowed"
                : "bg-accent text-white hover:bg-accent-hover"
            }`}
            title="Add participant"
            aria-label="Add participant"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={onDownloadParticipants}
            disabled={!currentMeetingId || participants.length === 0}
            className={`w-10 h-10 flex items-center justify-center rounded-lg border transition-colors ${
              !currentMeetingId || participants.length === 0
                ? "border-outline text-on-surface-tertiary cursor-not-allowed bg-surface-tertiary"
                : "border-outline text-on-surface-tertiary hover:bg-accent-soft hover:text-accent"
            }`}
            title="Download participants"
            aria-label="Download participants"
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onRemoveAllParticipants}
            disabled={participants.length === 0 || connected || settingsLocked}
            className={`w-10 h-10 flex items-center justify-center rounded-lg border transition-colors ${
              participants.length === 0 || connected || settingsLocked
                ? "border-outline text-on-surface-tertiary cursor-not-allowed bg-surface-tertiary"
                : "border-outline text-on-surface-tertiary hover:bg-red-50 hover:text-red-600"
            }`}
            title="Remove all participants"
            aria-label="Remove all participants"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div
        className={`relative rounded-lg min-h-[150px] overflow-hidden w-full transition-colors ${
          isDragOverParticipants
            ? "bg-surface-secondary border border-outline-secondary shadow-[0_0_0_3px_rgba(37,99,235,0.12)]"
            : "bg-surface-secondary border border-outline"
        }`}
        onDragOver={onParticipantsDragOver}
        onDragEnter={onParticipantsDragOver}
        onDragLeave={onParticipantsDragLeave}
        onDrop={onParticipantsDrop}
      >
        {order.length === 0 ? (
          <div className="min-h-[150px] flex flex-col items-center justify-center gap-3 text-on-surface-tertiary px-4">
            <svg
              className="w-12 h-12 opacity-50"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
              />
            </svg>
            <p className="text-sm">No participants yet. Click + to add.</p>
          </div>
        ) : null}
        {order.length > 0 ? (
          <div className="w-full p-4 min-w-0 flex items-center">
            <div className="overflow-x-auto w-full">
              <DnDParticipants
                order={order}
                participants={participants}
                includeHuman={includeHuman}
                humanName={humanName}
                humanAvatar={humanAvatar}
                humanRole={humanRole}
                onHumanMenuOpen={settingsLocked ? undefined : onHumanMenuOpen}
                apiBase={apiBase}
                meetingId={currentMeetingId!}
                onOrderChange={(next) => setOrder(next)}
                onParticipantMenuOpen={settingsLocked ? undefined : showParticipantMenu}
                onParticipantView={onViewParticipant}
                locked={settingsLocked}
              />
            </div>
          </div>
        ) : null}
        {isDragOverParticipants && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm font-medium pointer-events-none bg-surface-secondary text-on-surface-secondary">
            <UploadCloud className="w-6 h-6" />
            <span>Drop participants JSON to import</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default ParticipantsSection;
