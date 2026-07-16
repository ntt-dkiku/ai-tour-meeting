import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ContextMenu from "../../components/ContextMenu";

const baseProps = {
  settingsLocked: false,
  participants: [],
  onClose: vi.fn(),
  onEditMeeting: vi.fn(),
  onDuplicateMeeting: vi.fn(),
  onDeleteMeeting: vi.fn(),
  onExportData: vi.fn(),
  onEditParticipant: vi.fn(),
  onDuplicateParticipant: vi.fn(),
  onDeleteParticipant: vi.fn(),
};

describe("ContextMenu (human)", () => {
  const humanMenu = { x: 0, y: 0, type: "human" as const };

  it("shows only Edit and Delete (no Duplicate) for the human", () => {
    render(
      <ContextMenu
        {...baseProps}
        contextMenu={humanMenu}
        onEditHuman={vi.fn()}
        onDeleteHuman={vi.fn()}
      />
    );
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.queryByText("Duplicate")).toBeNull();
  });

  it("fires onEditHuman and onDeleteHuman", () => {
    const onEditHuman = vi.fn();
    const onDeleteHuman = vi.fn();
    render(
      <ContextMenu
        {...baseProps}
        contextMenu={humanMenu}
        onEditHuman={onEditHuman}
        onDeleteHuman={onDeleteHuman}
      />
    );
    fireEvent.click(screen.getByText("Edit"));
    expect(onEditHuman).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Delete"));
    expect(onDeleteHuman).toHaveBeenCalled();
  });

  it("does not act while settings are locked", () => {
    const onDeleteHuman = vi.fn();
    render(
      <ContextMenu
        {...baseProps}
        settingsLocked
        contextMenu={humanMenu}
        onEditHuman={vi.fn()}
        onDeleteHuman={onDeleteHuman}
      />
    );
    fireEvent.click(screen.getByText("Delete"));
    expect(onDeleteHuman).not.toHaveBeenCalled();
  });
});
