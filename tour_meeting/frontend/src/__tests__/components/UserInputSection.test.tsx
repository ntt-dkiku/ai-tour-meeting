import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import UserInputSection from "../../components/meeting/UserInputSection";

const proposal = {
  id: 1,
  participant: "Amina",
  message: "A relaxed cultural day.",
  route: ["Kiyomizu-dera", "Gion"],
  destinations: [],
};

const makeVotingData = (votingRule: string, extra: Record<string, unknown> = {}) => ({
  vote_type: "route",
  turn: 5,
  options: { proposals: [proposal], voting_rule: votingRule },
  step: 1,
  maxSteps: 3,
  candidates: ["Amina"],
  canAsk: true,
  ...extra,
});

const makeHumanTurn = (extra: Record<string, unknown> = {}) => ({
  step: 1,
  maxSteps: 3,
  candidates: ["Amina"],
  canAsk: true,
  canPropose: true,
  ...extra,
});

const baseProps = {
  includeHuman: true,
  connected: true,
  waitingForUser: false,
  humanTurnData: null as any,
  waitingForVote: false,
  votingData: null as any,
  waitingForSelect: false,
  selectSpeakerData: null,
  sendUserSelection: vi.fn(),
  waitingForAskAnswer: false,
  askAnswerData: null,
  sendAskAnswer: vi.fn(),
  participantAvatars: {},
  humanName: "You",
  humanAvatar: null,
  userMessage: "",
  setUserMessage: vi.fn(),
  needModification: false,
  setNeedModification: vi.fn(),
  routeVoteSelections: { accept: null, score: null, message: "" },
  setRouteVoteSelections: vi.fn(),
  consensusVoteSelections: { approved: [], rejected: [], scores: [], message: "" },
  setConsensusVoteSelections: vi.fn(),
  sendHumanAction: vi.fn(),
  sendUserVote: vi.fn(),
  generateHumanRoute: vi.fn(),
  logs: [] as any[],
  modelGroups: [
    {
      label: "Commercial",
      options: [
        { value: "openai/gpt-5-mini-2025-08-07", label: "openai/gpt-5-mini-2025-08-07" },
        { value: "anthropic/claude-3-5-sonnet-20241022", label: "anthropic/claude-3-5-sonnet-20241022" },
      ],
    },
  ],
  defaultModel: "openai/gpt-5-mini-2025-08-07",
};

describe("UserInputSection speaking turn", () => {
  it("shows the action tabs and an enabled composer", () => {
    render(<UserInputSection {...baseProps} waitingForUser humanTurnData={makeHumanTurn()} />);
    expect(screen.getByText("Speak")).toBeInTheDocument();
    expect(screen.getByText("Ask")).toBeInTheDocument();
    expect(screen.getByText("Propose")).toBeInTheDocument();
    expect(screen.getByText("Satisfied")).toBeInTheDocument();
    const box = screen.getByPlaceholderText("Type your message...") as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
  });

  it("sends a speak action via the composer send icon", () => {
    const sendHumanAction = vi.fn();
    render(
      <UserInputSection
        {...baseProps}
        waitingForUser
        humanTurnData={makeHumanTurn()}
        userMessage="My opinion."
        sendHumanAction={sendHumanAction}
      />
    );
    fireEvent.click(screen.getByLabelText("Send"));
    expect(sendHumanAction).toHaveBeenCalledWith({
      action: "speak",
      message: "My opinion.",
      need_modification: false,
    });
  });

  it("sends an ask action to the selected participant", () => {
    const sendHumanAction = vi.fn();
    render(
      <UserInputSection
        {...baseProps}
        waitingForUser
        humanTurnData={makeHumanTurn()}
        userMessage="What's your budget?"
        sendHumanAction={sendHumanAction}
      />
    );
    fireEvent.click(screen.getByText("Ask"));
    fireEvent.click(screen.getByLabelText("Send"));
    expect(sendHumanAction).toHaveBeenCalledWith({
      action: "ask",
      target: "Amina",
      message: "What's your budget?",
    });
  });

  it("opens the route editor without a separate submit button when Propose is chosen", () => {
    render(<UserInputSection {...baseProps} waitingForUser humanTurnData={makeHumanTurn()} />);
    fireEvent.click(screen.getByText("Propose"));
    expect(screen.getByText("Your proposal")).toBeInTheDocument();
    expect(screen.getByText("Generate with AI")).toBeInTheDocument();
    expect(screen.getByText("Add destination")).toBeInTheDocument();
    // No separate "Propose route" button — the composer's send submits.
    expect(screen.queryByText("Propose route")).toBeNull();
    // Send is present but disabled until the route has two named stops.
    expect((screen.getByLabelText("Send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("proposes the route via the composer send once two stops are named", () => {
    const sendHumanAction = vi.fn();
    render(
      <UserInputSection
        {...baseProps}
        waitingForUser
        humanTurnData={makeHumanTurn()}
        userMessage="Here's my plan."
        sendHumanAction={sendHumanAction}
      />
    );
    fireEvent.click(screen.getByText("Propose"));
    fireEvent.click(screen.getByText("Add destination"));
    fireEvent.click(screen.getByText("Add destination"));
    const nameInputs = screen.getAllByPlaceholderText("Destination name");
    fireEvent.change(nameInputs[0], { target: { value: "Museum" } });
    fireEvent.change(nameInputs[1], { target: { value: "Park" } });
    const send = screen.getByLabelText("Send") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(sendHumanAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "propose", message: "Here's my plan." })
    );
  });

  it("opens the AI refine dialog from Generate with AI without generating immediately", () => {
    const generateHumanRoute = vi.fn().mockResolvedValue({ message: "ok", route: [] });
    render(
      <UserInputSection
        {...baseProps}
        waitingForUser
        humanTurnData={makeHumanTurn()}
        generateHumanRoute={generateHumanRoute}
      />
    );
    fireEvent.click(screen.getByText("Propose"));
    fireEvent.click(screen.getByText("Generate with AI"));
    // A dialog opens (with the proposal + chat); it does not generate yet.
    expect(screen.getByText("Refine your proposal with AI")).toBeInTheDocument();
    expect(generateHumanRoute).not.toHaveBeenCalled();
  });

  it("shows the model picker in the AI refine dialog and switches models", async () => {
    const generateHumanRoute = vi.fn().mockResolvedValue({ message: "ok", route: [] });
    render(
      <UserInputSection
        {...baseProps}
        waitingForUser
        humanTurnData={makeHumanTurn()}
        generateHumanRoute={generateHumanRoute}
      />
    );
    fireEvent.click(screen.getByText("Propose"));
    fireEvent.click(screen.getByText("Generate with AI"));

    const dialog = screen.getByText("Refine your proposal with AI").closest("div")!
      .parentElement as HTMLElement;

    const modelButton = within(dialog).getByTitle("openai/gpt-5-mini-2025-08-07");
    expect(modelButton).toHaveTextContent("gpt-5-mini-2025-08-07");

    fireEvent.click(modelButton);
    // The menu is grouped like the participant Model dropdown.
    expect(within(dialog).getByText("Commercial")).toBeInTheDocument();
    expect(within(dialog).getByText("Custom…")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText("anthropic/claude-3-5-sonnet-20241022"));

    const composerPlaceholder =
      "Describe the route, or how to change it (e.g. add a lunch stop)…";
    const dialogInput = screen.getByPlaceholderText(composerPlaceholder);
    fireEvent.change(dialogInput, { target: { value: "Add a lunch stop" } });

    // Both the dialog composer and the main composer behind it have a "Send"
    // button; scope to the dialog so we click the right one regardless of
    // DOM order.
    fireEvent.click(within(dialog).getByLabelText("Send"));

    await screen.findByText("ok");
    expect(generateHumanRoute).toHaveBeenCalledWith(
      "Add a lunch stop",
      expect.any(Array),
      "anthropic/claude-3-5-sonnet-20241022",
      expect.any(Array)
    );
  });

  it("keeps AI edits in the main editor after closing the dialog (auto-save)", async () => {
    const generateHumanRoute = vi
      .fn()
      .mockResolvedValue({ message: "ok", route: [{ name: "Museum" }] });
    render(
      <UserInputSection
        {...baseProps}
        waitingForUser
        humanTurnData={makeHumanTurn()}
        generateHumanRoute={generateHumanRoute}
      />
    );
    fireEvent.click(screen.getByText("Propose"));
    fireEvent.click(screen.getByText("Generate with AI"));

    const dialog = screen.getByText("Refine your proposal with AI").closest("div")!
      .parentElement as HTMLElement;
    const composerPlaceholder =
      "Describe the route, or how to change it (e.g. add a lunch stop)…";
    fireEvent.change(screen.getByPlaceholderText(composerPlaceholder), {
      target: { value: "Draft something" },
    });
    fireEvent.click(within(dialog).getByLabelText("Send"));
    await screen.findByText("ok");

    // No Apply button: closing with the X keeps the AI-drafted route.
    expect(screen.queryByText("Apply")).toBeNull();
    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.queryByText("Refine your proposal with AI")).toBeNull();
    expect(screen.getByDisplayValue("Museum")).toBeInTheDocument();
  });

  it("sends the prior dialog exchanges as history on the next message", async () => {
    const generateHumanRoute = vi.fn().mockResolvedValue({ message: "ok", route: [] });
    render(
      <UserInputSection
        {...baseProps}
        waitingForUser
        humanTurnData={makeHumanTurn()}
        generateHumanRoute={generateHumanRoute}
      />
    );
    fireEvent.click(screen.getByText("Propose"));
    fireEvent.click(screen.getByText("Generate with AI"));

    const dialog = screen.getByText("Refine your proposal with AI").closest("div")!
      .parentElement as HTMLElement;
    const composerPlaceholder =
      "Describe the route, or how to change it (e.g. add a lunch stop)…";

    fireEvent.change(screen.getByPlaceholderText(composerPlaceholder), {
      target: { value: "First message" },
    });
    fireEvent.click(within(dialog).getByLabelText("Send"));
    await screen.findByText("ok");
    // First call carries no history.
    expect(generateHumanRoute.mock.calls[0][3]).toEqual([]);

    fireEvent.change(screen.getByPlaceholderText(composerPlaceholder), {
      target: { value: "Second message" },
    });
    fireEvent.click(within(dialog).getByLabelText("Send"));
    await screen.findAllByText("ok");
    // Second call carries the first exchange, oldest first.
    expect(generateHumanRoute.mock.calls[1][3]).toEqual([
      { role: "user", content: "First message" },
      { role: "ai", content: "ok" },
    ]);
  });

  it("keeps a generation running in the background when the dialog is closed", async () => {
    let resolveDraft: (v: any) => void = () => {};
    const generateHumanRoute = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveDraft = resolve;
      })
    );
    render(
      <UserInputSection
        {...baseProps}
        waitingForUser
        humanTurnData={makeHumanTurn()}
        generateHumanRoute={generateHumanRoute}
      />
    );
    fireEvent.click(screen.getByText("Propose"));
    fireEvent.click(screen.getByText("Generate with AI"));

    const dialog = screen.getByText("Refine your proposal with AI").closest("div")!
      .parentElement as HTMLElement;
    const composerPlaceholder =
      "Describe the route, or how to change it (e.g. add a lunch stop)…";
    fireEvent.change(screen.getByPlaceholderText(composerPlaceholder), {
      target: { value: "Draft something" },
    });
    fireEvent.click(within(dialog).getByLabelText("Send"));

    // Close mid-generation, then let the draft finish in the background.
    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.queryByText("Refine your proposal with AI")).toBeNull();
    await act(async () => {
      resolveDraft({ message: "ok", route: [{ name: "Museum" }] });
    });

    // The result still lands in the main editor…
    expect(screen.getByDisplayValue("Museum")).toBeInTheDocument();
    // …and reopening shows the finished conversation instead of a reset one.
    fireEvent.click(screen.getByText("Generate with AI"));
    expect(screen.getByText("ok")).toBeInTheDocument();
  });

  it("Reset restores the route from when the dialog opened and clears the chat", async () => {
    const generateHumanRoute = vi
      .fn()
      .mockResolvedValue({ message: "ok", route: [{ name: "Museum" }] });
    render(
      <UserInputSection
        {...baseProps}
        waitingForUser
        humanTurnData={makeHumanTurn()}
        generateHumanRoute={generateHumanRoute}
      />
    );
    fireEvent.click(screen.getByText("Propose"));
    fireEvent.click(screen.getByText("Generate with AI"));

    const dialog = screen.getByText("Refine your proposal with AI").closest("div")!
      .parentElement as HTMLElement;
    const composerPlaceholder =
      "Describe the route, or how to change it (e.g. add a lunch stop)…";
    fireEvent.change(screen.getByPlaceholderText(composerPlaceholder), {
      target: { value: "Draft something" },
    });
    fireEvent.click(within(dialog).getByLabelText("Send"));
    await screen.findByText("ok");
    // The shared route renders in both the dialog and the editor behind it.
    expect(screen.getAllByDisplayValue("Museum").length).toBeGreaterThan(0);

    fireEvent.click(within(dialog).getByText("Reset"));
    // The dialog opened with an empty route, so the AI draft is discarded
    // and the chat log is cleared.
    expect(screen.queryByDisplayValue("Museum")).toBeNull();
    expect(screen.queryByText("ok")).toBeNull();
  });

  it("sends a custom model typed via the picker's Custom mode", async () => {
    const generateHumanRoute = vi.fn().mockResolvedValue({ message: "ok", route: [] });
    render(
      <UserInputSection
        {...baseProps}
        waitingForUser
        humanTurnData={makeHumanTurn()}
        generateHumanRoute={generateHumanRoute}
      />
    );
    fireEvent.click(screen.getByText("Propose"));
    fireEvent.click(screen.getByText("Generate with AI"));

    const dialog = screen.getByText("Refine your proposal with AI").closest("div")!
      .parentElement as HTMLElement;

    fireEvent.click(within(dialog).getByTitle("openai/gpt-5-mini-2025-08-07"));
    fireEvent.click(within(dialog).getByText("Custom…"));
    fireEvent.change(within(dialog).getByLabelText("Custom model"), {
      target: { value: "ollama/my-local-model" },
    });

    const composerPlaceholder =
      "Describe the route, or how to change it (e.g. add a lunch stop)…";
    fireEvent.change(screen.getByPlaceholderText(composerPlaceholder), {
      target: { value: "Add a lunch stop" },
    });
    fireEvent.click(within(dialog).getByLabelText("Send"));

    await screen.findByText("ok");
    expect(generateHumanRoute).toHaveBeenCalledWith(
      "Add a lunch stop",
      expect.any(Array),
      "ollama/my-local-model",
      expect.any(Array)
    );
  });

  it("sends the default model when the picker isn't touched", async () => {
    const generateHumanRoute = vi.fn().mockResolvedValue({ message: "ok", route: [] });
    render(
      <UserInputSection
        {...baseProps}
        waitingForUser
        humanTurnData={makeHumanTurn()}
        generateHumanRoute={generateHumanRoute}
      />
    );
    fireEvent.click(screen.getByText("Propose"));
    fireEvent.click(screen.getByText("Generate with AI"));

    const dialog = screen.getByText("Refine your proposal with AI").closest("div")!
      .parentElement as HTMLElement;

    const composerPlaceholder =
      "Describe the route, or how to change it (e.g. add a lunch stop)…";
    const dialogInput = screen.getByPlaceholderText(composerPlaceholder);
    fireEvent.change(dialogInput, { target: { value: "Add a lunch stop" } });

    fireEvent.click(within(dialog).getByLabelText("Send"));

    await screen.findByText("ok");
    expect(generateHumanRoute).toHaveBeenCalledWith(
      "Add a lunch stop",
      expect.any(Array),
      "openai/gpt-5-mini-2025-08-07",
      expect.any(Array)
    );
  });

  it("sends a satisfied action from the Satisfied tab via the composer", () => {
    const sendHumanAction = vi.fn();
    render(
      <UserInputSection
        {...baseProps}
        waitingForUser
        humanTurnData={makeHumanTurn()}
        sendHumanAction={sendHumanAction}
      />
    );
    fireEvent.click(screen.getByText("Satisfied"));
    // No separate button: the composer's send icon concludes (a comment is
    // optional, so it's enabled even with an empty message).
    fireEvent.click(screen.getByLabelText("Send"));
    expect(sendHumanAction).toHaveBeenCalledWith({ action: "satisfied", message: "" });
  });

  it("hides the Ask tab when the human cannot ask (final step)", () => {
    render(
      <UserInputSection
        {...baseProps}
        waitingForUser
        humanTurnData={makeHumanTurn({ canAsk: false })}
      />
    );
    expect(screen.queryByText("Ask")).toBeNull();
    expect(screen.getByText("Speak")).toBeInTheDocument();
  });
});

describe("UserInputSection voting turn", () => {
  it("shows the judge panel with Accept/Reject and the vote send icon", () => {
    render(
      <UserInputSection
        {...baseProps}
        waitingForVote
        votingData={makeVotingData("majority")}
      />
    );
    expect(screen.getByText("Judge")).toBeInTheDocument();
    expect(screen.getByText("Accept")).toBeInTheDocument();
    expect(screen.getByText("Reject")).toBeInTheDocument();
    // The proposal card is intentionally not shown (it's already in the chat).
    expect(screen.queryByText("Amina's proposal")).toBeNull();
    // The judge submits through the composer's vote icon (same box shape).
    expect(screen.getByLabelText("Submit vote")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Add a comment (optional)...")).toBeInTheDocument();
  });

  it("submits a judge (accept) vote via the vote icon with the composer message", () => {
    const sendUserVote = vi.fn();
    render(
      <UserInputSection
        {...baseProps}
        waitingForVote
        votingData={makeVotingData("majority")}
        routeVoteSelections={{ accept: true, score: null, message: "" }}
        userMessage="Looks good."
        sendUserVote={sendUserVote}
      />
    );
    fireEvent.click(screen.getByLabelText("Submit vote"));
    expect(sendUserVote).toHaveBeenCalledWith({
      action: "judge",
      accept: true,
      message: "Looks good.",
    });
  });

  it("disables the vote icon until a choice is made", () => {
    render(
      <UserInputSection
        {...baseProps}
        waitingForVote
        votingData={makeVotingData("majority")}
        routeVoteSelections={{ accept: null, score: null, message: "" }}
      />
    );
    expect((screen.getByLabelText("Submit vote") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a score input for score-based rules and submits a score judge", () => {
    const sendUserVote = vi.fn();
    render(
      <UserInputSection
        {...baseProps}
        waitingForVote
        votingData={makeVotingData("most_pleasure")}
        routeVoteSelections={{ accept: null, score: 8, message: "" }}
        userMessage=""
        sendUserVote={sendUserVote}
      />
    );
    expect(screen.getByLabelText("Score (1-10):")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Submit vote"));
    expect(sendUserVote).toHaveBeenCalledWith({ action: "judge", score: 8, message: "" });
  });

  it("sends an ask action during voting", () => {
    const sendUserVote = vi.fn();
    render(
      <UserInputSection
        {...baseProps}
        waitingForVote
        votingData={makeVotingData("majority")}
        userMessage="Does this fit the budget?"
        sendUserVote={sendUserVote}
      />
    );
    fireEvent.click(screen.getByText("Ask"));
    fireEvent.click(screen.getByLabelText("Send"));
    expect(sendUserVote).toHaveBeenCalledWith({
      action: "ask",
      target: "Amina",
      message: "Does this fit the budget?",
    });
  });
});

describe("UserInputSection ask answer (LLM asked the human)", () => {
  it("shows the asker's question as a header above the composer", () => {
    render(
      <UserInputSection
        {...baseProps}
        waitingForAskAnswer
        askAnswerData={{ turn: 4, asker: "Amina", question: "What is your budget?" }}
      />
    );
    expect(screen.getByText("Amina asked you a question")).toBeInTheDocument();
    expect(screen.getByText("What is your budget?")).toBeInTheDocument();
    const box = screen.getByPlaceholderText("Type your answer...") as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
  });

  it("submits the answer through the composer send icon", () => {
    const sendAskAnswer = vi.fn();
    const setUserMessage = vi.fn();
    render(
      <UserInputSection
        {...baseProps}
        waitingForAskAnswer
        askAnswerData={{ turn: 4, asker: "Amina", question: "What is your budget?" }}
        userMessage="Around $100."
        setUserMessage={setUserMessage}
        sendAskAnswer={sendAskAnswer}
      />
    );
    fireEvent.click(screen.getByLabelText("Send"));
    expect(sendAskAnswer).toHaveBeenCalledWith("Around $100.");
    expect(setUserMessage).toHaveBeenCalledWith("");
  });
});

describe("UserInputSection idle / gating", () => {
  it("shows a disabled composer while waiting for the AI participants", () => {
    render(<UserInputSection {...baseProps} />);
    const input = screen.getByPlaceholderText("Waiting for your turn to speak...") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
  });

  it("returns null when the human is not participating", () => {
    const { container } = render(<UserInputSection {...baseProps} includeHuman={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("lists candidates and sends the chosen speaker as facilitator", () => {
    const sendUserSelection = vi.fn();
    render(
      <UserInputSection
        {...baseProps}
        waitingForSelect
        selectSpeakerData={{ turn: 3, candidates: ["Amina", "Bao"] }}
        sendUserSelection={sendUserSelection}
      />
    );
    expect(screen.getByText("Choose who speaks next")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Bao"));
    expect(sendUserSelection).toHaveBeenCalledWith("Bao");
  });
});
