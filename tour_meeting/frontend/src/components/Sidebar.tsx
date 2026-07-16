import React from "react";
import {
  PlusCircle,
  Trash2,
  Wrench,
  PanelLeftOpen,
  PanelLeftClose,
  MoreVertical,
  Zap,
  Sun,
  Moon,
  BookOpen,
} from "lucide-react";
import type { MeetingInfo, ContextMenuState } from "../types";
import { formatElapsed } from "../utils/formatting";
import {
  SIDEBAR_WIDTH,
  COLLAPSED_SIDEBAR_WIDTH,
  DOCUMENTATION_URL,
  getStatusStyle,
} from "../constants";
import { useTheme } from "../context/ThemeContext";

export interface SidebarProps {
  isSidebarOpen: boolean;
  setIsSidebarOpen: (open: boolean) => void;
  meetings: MeetingInfo[];
  currentMeetingId: string | null;
  elapsedSeconds: number;
  nowSeconds: number;
  meetingStartRef: React.MutableRefObject<Record<string, number>>;
  meetingResumeOffsetRef: React.MutableRefObject<Record<string, number>>;
  onGoHome: () => void;
  onCreateNewMeeting: () => Promise<void>;
  onGenerateRandomSample: () => Promise<void>;
  onSelectMeeting: (meetingId: string) => Promise<void>;
  onDeleteAllMeetings: () => Promise<void>;
  onOpenApiSettings: () => void;
  setContextMenu: (menu: ContextMenuState | null) => void;
}

export default function Sidebar({
  isSidebarOpen,
  setIsSidebarOpen,
  meetings,
  currentMeetingId,
  elapsedSeconds,
  nowSeconds,
  meetingStartRef,
  meetingResumeOffsetRef,
  onGoHome,
  onCreateNewMeeting,
  onGenerateRandomSample,
  onSelectMeeting,
  onDeleteAllMeetings,
  onOpenApiSettings,
  setContextMenu,
}: SidebarProps) {
  const { theme, toggleTheme } = useTheme();
  const currentSidebarWidth = isSidebarOpen ? SIDEBAR_WIDTH : COLLAPSED_SIDEBAR_WIDTH;
  const sidebarTransform = isSidebarOpen
    ? "translateX(0)"
    : `translateX(${COLLAPSED_SIDEBAR_WIDTH - SIDEBAR_WIDTH}px)`;

  // Icon-only buttons for the collapsed rail. They reuse the open sidebar's
  // vertical rhythm (header pt-6/pb-2 + p-2 toggle, then nav pt-2 with py-3
  // buttons) so each action icon sits at the same height whether open or shut.
  const railButtonClass =
    "px-2 py-3 flex items-center justify-center rounded-lg transition-colors text-sidebar-text hover:bg-sidebar-hover";

  return (
    <>
      {!isSidebarOpen && (
        <div
          className="absolute top-0 left-0 z-20 h-full flex flex-col bg-sidebar border-r border-sidebar-border"
          style={{ width: `${COLLAPSED_SIDEBAR_WIDTH}px` }}
        >
          <div className="pt-6 pb-2 flex items-center justify-center">
            <button
              type="button"
              onClick={() => setIsSidebarOpen(true)}
              className="p-2 rounded-lg transition-colors text-sidebar-text hover:bg-sidebar-hover"
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <PanelLeftOpen className="w-5 h-5" />
            </button>
          </div>

          <nav className="pt-2 flex flex-col items-center">
            <button
              type="button"
              onClick={onCreateNewMeeting}
              className={railButtonClass}
              aria-label="New meeting"
              title="New meeting"
            >
              <PlusCircle className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={onGenerateRandomSample}
              className={railButtonClass}
              aria-label="Random sampling"
              title="Random sampling"
            >
              <Zap className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={onOpenApiSettings}
              className={railButtonClass}
              aria-label="Settings"
              title="Settings"
            >
              <Wrench className="w-5 h-5" />
            </button>
            <a
              href={DOCUMENTATION_URL}
              target="_blank"
              rel="noreferrer"
              className={railButtonClass}
              aria-label="Open documentation in a new window"
              title="Document"
            >
              <BookOpen className="w-5 h-5" />
            </a>
          </nav>
        </div>
      )}

      <div
        className="relative h-full flex-shrink-0 overflow-hidden"
        style={{
          width: `${currentSidebarWidth}px`,
          transition: "width 0.3s ease",
        }}
      >
        <aside
          aria-hidden={!isSidebarOpen}
          className="flex flex-col h-full relative transition-transform duration-300 ease-in-out bg-sidebar border-r border-sidebar-border"
          style={{
            width: `${SIDEBAR_WIDTH}px`,
            borderColor: isSidebarOpen ? undefined : "transparent",
            pointerEvents: isSidebarOpen ? "auto" : "none",
            transform: sidebarTransform,
          }}
        >
          <div
            className="relative z-10 flex flex-col h-full"
            style={{
              opacity: isSidebarOpen ? 1 : 0,
              transition: "opacity 0.2s ease",
            }}
          >
            <div className="pt-6 pb-2 pl-6 pr-4 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={onGoHome}
                className="text-xl font-bold focus:outline-none text-sidebar-text bg-transparent border-none p-0 cursor-pointer"
              >
                AI Tour Meeting
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsSidebarOpen(false);
                  setContextMenu(null);
                }}
                className="p-2 rounded-lg transition-colors text-sidebar-text hover:bg-sidebar-hover"
                aria-label="Collapse sidebar"
              >
                <PanelLeftClose className="w-5 h-5" />
              </button>
            </div>

            <nav className="flex-1 px-4 pb-4 pt-2 overflow-auto">
              <button
                onClick={onCreateNewMeeting}
                className="w-full text-left px-2 py-3 rounded-lg transition-colors flex items-center gap-2 text-sidebar-text hover:bg-sidebar-hover"
              >
                <PlusCircle className="w-5 h-5" />
                <span className="text-sm font-medium">New meeting</span>
              </button>

              <button
                onClick={onGenerateRandomSample}
                className="w-full text-left px-2 py-3 rounded-lg transition-colors flex items-center gap-2 text-sidebar-text hover:bg-sidebar-hover"
              >
                <Zap className="w-5 h-5" />
                <span className="text-sm font-medium">Random sampling</span>
              </button>

              <div className="mb-4">
                <button
                  onClick={onOpenApiSettings}
                  className="w-full text-left px-2 py-3 rounded-lg transition-colors flex items-center gap-2 text-sidebar-text hover:bg-sidebar-hover"
                >
                  <Wrench className="w-5 h-5" />
                  <span className="text-sm font-medium">Settings</span>
                </button>

                <a
                  href={DOCUMENTATION_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="w-full text-left px-2 py-3 rounded-lg transition-colors flex items-center gap-2 text-sidebar-text hover:bg-sidebar-hover"
                  aria-label="Open documentation in a new window"
                >
                  <BookOpen className="w-5 h-5" />
                  <span className="text-sm font-medium">Document</span>
                </a>
              </div>

              <div className="mb-4">
                <div className="flex items-center justify-between mb-0.5 pl-2">
                  <h3 className="text-sm font-medium text-sidebar-text">
                    Meetings
                  </h3>
                  <button
                    type="button"
                    onClick={onDeleteAllMeetings}
                    disabled={meetings.length === 0}
                    className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors text-on-surface-tertiary hover:text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label="Delete all meetings"
                    title="Delete all meetings"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                {meetings.length === 0 ? (
                  <div className="text-left px-2 text-on-surface-tertiary">
                    <p className="text-sm">No meetings yet</p>
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {meetings.map((meeting) => {
                      const statusInfo = getStatusStyle(meeting.status);
                      const showStatus = meeting.status && meeting.status !== "idle";
                      const statusLower = (meeting.status ?? "").toLowerCase();
                      const isLive = statusLower === "running" || statusLower === "stopping";
                      const showPulse = statusLower === "running";
                      const showElapsedTime = ["running", "stopping", "stopped", "finished", "timeout"].includes(
                        statusLower
                      );
                      const startedAt = meetingStartRef.current[meeting.id];
                      const resumeOffset = meetingResumeOffsetRef.current[meeting.id] ?? 0;
                      const computedElapsed = startedAt
                        ? Math.max(0, nowSeconds - startedAt)
                        : resumeOffset;
                      const displayElapsed =
                        meeting.id === currentMeetingId ? elapsedSeconds : computedElapsed;
                      const isSelected = currentMeetingId === meeting.id;
                      return (
                        <div key={meeting.id} className="relative">
                          <button
                            onClick={() => onSelectMeeting(meeting.id)}
                            className={`w-full text-left px-2 py-3 rounded-lg transition-colors group text-sidebar-text ${
                              isSelected ? "font-medium bg-sidebar-hover" : "hover:bg-sidebar-hover"
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex-1 min-w-0">
                                <div className="text-sm truncate">{meeting.title}</div>
                                <div className="text-xs opacity-70 mt-1 flex items-center gap-2">
                                  <span>
                                    {meeting.participant_count + (meeting.include_human ? 1 : 0)} joined
                                  </span>
                                  {showStatus && (
                                    <div className="flex items-center gap-2">
                                      <span
                                        className={statusInfo.className}
                                        title={meeting.status_detail ?? undefined}
                                      >
                                        {showPulse && (
                                          <span className="relative inline-flex h-2.5 w-2.5">
                                            <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-75 animate-ping"></span>
                                            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-accent"></span>
                                          </span>
                                        )}
                                        {statusInfo.label}
                                      </span>
                                      {showElapsedTime && (
                                        <span
                                          className={
                                            statusLower === "running"
                                              ? "text-xs text-accent font-medium"
                                              : statusLower === "stopping"
                                              ? "text-xs text-amber-600 font-medium"
                                              : statusLower === "finished"
                                              ? "text-xs text-green-600 font-medium"
                                              : statusLower === "timeout"
                                              ? "text-xs text-red-500 font-medium"
                                              : "text-xs text-on-surface-tertiary font-medium"
                                          }
                                        >
                                          {formatElapsed(Math.max(0, displayElapsed))}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                              <div
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  setContextMenu({
                                    meetingId: meeting.id,
                                    x: rect.left,
                                    y: rect.bottom + 4,
                                    type: 'meeting'
                                  });
                                }}
                                className="opacity-0 group-hover:opacity-100 transition-opacity ml-2 rounded cursor-pointer"
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.stopPropagation();
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    setContextMenu({
                                      meetingId: meeting.id,
                                      x: rect.left,
                                      y: rect.bottom + 4,
                                      type: 'meeting'
                                    });
                                  }
                                }}
                              >
                                <MoreVertical className="w-4 h-4" />
                              </div>
                            </div>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </nav>

            {/* Theme toggle at bottom */}
            <div className="px-4 pb-4 border-t border-sidebar-border pt-3">
              <button
                onClick={toggleTheme}
                className="w-full flex items-center gap-2 px-2 py-2.5 rounded-lg transition-colors text-sidebar-text hover:bg-sidebar-hover"
              >
                {theme === "light" ? (
                  <Moon className="w-5 h-5" />
                ) : (
                  <Sun className="w-5 h-5" />
                )}
                <span className="text-sm font-medium">
                  {theme === "light" ? "Dark mode" : "Light mode"}
                </span>
              </button>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
