import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import WorkflowSection from "../../components/settings/WorkflowSection";

const baseProps = {
  turnRule: "round_robin",
  setTurnRule: vi.fn(),
  draftVotingRule: "majority",
  setDraftVotingRule: vi.fn(),
  singleDecider: "",
  setSingleDecider: vi.fn(),
  deciderOptions: [
    { value: "id-a", label: "Amina" },
    { value: "__YOU__", label: "You" },
  ],
  volunteerMode: false,
  setVolunteerMode: vi.fn(),
  balancedTurns: true,
  setBalancedTurns: vi.fn(),
  voteTurnRule: "round_robin",
  setVoteTurnRule: vi.fn(),
  voteSettingsLinked: true,
  setVoteSettingsLinked: vi.fn(),
  settingsLocked: false,
};

describe("WorkflowSection", () => {
  it("uses sentence-case labels", () => {
    render(<WorkflowSection {...baseProps} />);
    expect(screen.getByText("Conversation settings")).toBeInTheDocument();
    expect(screen.getByText("Vote settings")).toBeInTheDocument();
    expect(screen.getAllByText("Turn rule")).toHaveLength(2);
    expect(screen.getByText("Voting rule")).toBeInTheDocument();
    expect(screen.queryByText("Turn Rule")).toBeNull();
    expect(screen.queryByText("Voting Rule")).toBeNull();
  });

  it("hides the decider select unless the rule is single_decider", () => {
    render(<WorkflowSection {...baseProps} />);
    expect(screen.queryByText("Decider")).toBeNull();
  });

  it("shows the decider select with participant options for single_decider", () => {
    render(
      <WorkflowSection
        {...baseProps}
        draftVotingRule="single_decider"
        singleDecider="id-a"
      />
    );
    expect(screen.getByText("Decider")).toBeInTheDocument();
    const select = screen.getByLabelText("Decider") as HTMLSelectElement;
    expect(select.value).toBe("id-a");
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toEqual(["Amina", "You"]);
  });

  it("propagates decider selection changes", () => {
    const setSingleDecider = vi.fn();
    render(
      <WorkflowSection
        {...baseProps}
        draftVotingRule="single_decider"
        singleDecider="id-a"
        setSingleDecider={setSingleDecider}
      />
    );
    fireEvent.change(screen.getByLabelText("Decider"), {
      target: { value: "__YOU__" },
    });
    expect(setSingleDecider).toHaveBeenCalledWith("__YOU__");
  });

  it("disables the decider select while settings are locked", () => {
    render(
      <WorkflowSection
        {...baseProps}
        draftVotingRule="single_decider"
        singleDecider="id-a"
        settingsLocked
      />
    );
    expect((screen.getByLabelText("Decider") as HTMLSelectElement).disabled).toBe(true);
  });
});
