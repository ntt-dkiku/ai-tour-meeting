import React from "react";
import { Edit2, Trash2, Download, Copy, CopyPlus } from "lucide-react";
import type { ContextMenuState, ParticipantIn } from "../types";

interface ContextMenuProps {
  contextMenu: ContextMenuState;
  settingsLocked: boolean;
  participants: ParticipantIn[];
  onClose: () => void;
  onEditMeeting: () => void;
  onDuplicateMeeting?: (meetingId: string) => void;
  onDeleteMeeting: (meetingId: string) => void;
  onExportData?: (meetingId: string) => void;
  onEditParticipant: (participant: ParticipantIn, index: number) => void;
  onDuplicateParticipant: (participantId: string) => void;
  onDeleteParticipant: (participantId: string) => void;
  onEditHuman?: () => void;
  onDeleteHuman?: () => void;
}

export default function ContextMenu({
  contextMenu,
  settingsLocked,
  participants,
  onClose,
  onEditMeeting,
  onDuplicateMeeting,
  onDeleteMeeting,
  onExportData,
  onEditParticipant,
  onDuplicateParticipant,
  onDeleteParticipant,
  onEditHuman,
  onDeleteHuman,
}: ContextMenuProps) {
  return (
    <div
      className="fixed bg-surface rounded-lg shadow-lg border border-outline py-1 z-50 min-w-[150px]"
      style={{
        left: `${contextMenu.x}px`,
        top: `${contextMenu.y}px`,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {contextMenu.type === 'human' ? (
        <>
          <button
            onClick={() => {
              if (settingsLocked) {
                onClose();
                return;
              }
              onEditHuman?.();
              onClose();
            }}
            className="w-full text-left px-4 py-2 text-sm text-on-surface-secondary hover:bg-surface-secondary transition-colors flex items-center gap-2"
          >
            <Edit2 className="w-4 h-4" />
            Edit
          </button>
          <button
            onClick={() => {
              if (settingsLocked) {
                onClose();
                return;
              }
              onDeleteHuman?.();
              onClose();
            }}
            className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </button>
        </>
      ) : contextMenu.type === 'meeting' ? (
        <>
          <button
            onClick={() => {
              onEditMeeting();
              onClose();
            }}
            className="w-full text-left px-4 py-2 text-sm text-on-surface-secondary hover:bg-surface-secondary transition-colors flex items-center gap-2"
          >
            <Edit2 className="w-4 h-4" />
            Edit
          </button>
          {onDuplicateMeeting && (
            <button
              onClick={() => {
                if (contextMenu.meetingId) {
                  onDuplicateMeeting(contextMenu.meetingId);
                }
                onClose();
              }}
              className="w-full text-left px-4 py-2 text-sm text-on-surface-secondary hover:bg-surface-secondary transition-colors flex items-center gap-2"
            >
              <Copy className="w-4 h-4" />
              Duplicate
            </button>
          )}
          {onExportData && (
            <button
              onClick={() => {
                if (contextMenu.meetingId) {
                  onExportData(contextMenu.meetingId);
                }
                onClose();
              }}
              className="w-full text-left px-4 py-2 text-sm text-on-surface-secondary hover:bg-surface-secondary transition-colors flex items-center gap-2"
            >
              <Download className="w-4 h-4" />
              Export Data
            </button>
          )}
          <button
            onClick={() => {
              if (contextMenu.meetingId) {
                onDeleteMeeting(contextMenu.meetingId);
              }
              onClose();
            }}
            className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </button>
        </>
      ) : (
        <>
          <button
            onClick={() => {
              if (settingsLocked) {
                onClose();
                return;
              }
              if (contextMenu.participantId) {
                const byId = (p: ParticipantIn) => (p.id ?? p.name) === contextMenu.participantId;
                const participant = participants.find(byId);
                const index = participants.findIndex(byId);
                if (participant) {
                  onEditParticipant(participant, index);
                }
              }
              onClose();
            }}
            className="w-full text-left px-4 py-2 text-sm text-on-surface-secondary hover:bg-surface-secondary transition-colors flex items-center gap-2"
          >
            <Edit2 className="w-4 h-4" />
            Edit
          </button>
          <button
            onClick={() => {
              if (settingsLocked) {
                onClose();
                return;
              }
              if (contextMenu.participantId) {
                onDuplicateParticipant(contextMenu.participantId);
              }
              onClose();
            }}
            className="w-full text-left px-4 py-2 text-sm text-on-surface-secondary hover:bg-surface-secondary transition-colors flex items-center gap-2"
          >
            <CopyPlus className="w-4 h-4" />
            Duplicate
          </button>
          <button
            onClick={() => {
              if (settingsLocked) {
                onClose();
                return;
              }
              if (contextMenu.participantId) {
                onDeleteParticipant(contextMenu.participantId);
              }
              onClose();
            }}
            className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </button>
        </>
      )}
    </div>
  );
}
