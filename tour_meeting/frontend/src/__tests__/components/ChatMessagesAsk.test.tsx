import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "@testing-library/react";
import ChatMessages from "../../components/meeting/ChatMessages";
import type { LogEntry } from "../../types";

function renderWith(logs: LogEntry[], parallelVoting = false) {
  const ref = React.createRef<HTMLDivElement>();
  const endRef = React.createRef<HTMLDivElement>();
  return render(
    <ChatMessages
      logs={logs}
      expandedObservations={{}}
      setExpandedObservations={vi.fn()}
      chatContainerRef={ref}
      handleChatScroll={vi.fn()}
      logsEndRef={endRef}
      showScrollButton={false}
      scrollToBottom={vi.fn()}
      routeScrollPositionsRef={{ current: {} }}
      avatars={{ Taro: null }}
      parallelVoting={parallelVoting}
    />
  );
}

const askStepEntry = {
  kind: "message",
  name: "Mika",
  turn: 2,
  content: "",
  stepsLabel: "participate",
  stepsLog: "[Step 1/5 - ask]\nWhich area do you prefer, Taro?\nAsk: Taro",
} as any;

describe("ChatMessages ask step", () => {
  it("shows the target's avatar+name and typing dots inside the ask box while pending", () => {
    const { container, queryByText, queryAllByText } = renderWith([
      askStepEntry,
      {
        kind: "ask_exchange",
        turn: 2,
        asker: "Mika",
        target: "Taro",
        question: "Which area do you prefer, Taro?",
        response: "",
        pending: true,
      },
    ]);
    // The step message doubles as the question and appears exactly once.
    expect(queryAllByText("Which area do you prefer, Taro?", { exact: false }).length).toBe(1);
    // Target name shown inside the ask box, dots while the answer is pending.
    expect(queryByText("Taro")).toBeTruthy();
    expect(container.querySelectorAll(".typing-dot").length).toBe(3);
    // Pending dots stand alone: no bubble frame around them, and the
    // "replied to" chip waits until the answer lands.
    expect(container.querySelector(".typing-dot")!.closest(".bg-surface-secondary")).toBeNull();
    expect(container.textContent).not.toContain("replied to");
    // No standalone "X asked Y" card anymore.
    expect(queryByText(/asked/)).toBeNull();
  });

  it("shows the answer under the target's name (and no dots) once the turn completes", () => {
    const { container, queryByText } = renderWith([
      { ...askStepEntry, content: "Thanks — then let's start in Higashiyama." },
      {
        kind: "ask_exchange",
        turn: 2,
        asker: "Mika",
        target: "Taro",
        question: "Which area do you prefer, Taro?",
        response: "I prefer Higashiyama.",
        pending: false,
      },
    ]);
    expect(queryByText("I prefer Higashiyama.", { exact: false })).toBeTruthy();
    expect(container.querySelectorAll(".typing-dot").length).toBe(0);
  });

  it("renders the answer from a persisted AskA line when no exchange entry exists", () => {
    const { container, queryByText } = renderWith([
      {
        ...askStepEntry,
        content: "Thanks — then let's start in Higashiyama.",
        stepsLog:
          "[Step 1/5 - ask]\nWhich area do you prefer, Taro?\nAsk: Taro\nAskA: I prefer Higashiyama.",
      },
    ]);
    expect(queryByText("I prefer Higashiyama.", { exact: false })).toBeTruthy();
    expect(container.querySelectorAll(".typing-dot").length).toBe(0);
  });

  it("shows the conclude block and typing dots while the route JSON is generated", () => {
    const { container, queryAllByText, queryByText } = renderWith([
      {
        kind: "message",
        name: "Mika",
        turn: 3,
        content: "",
        stepsLabel: "participate",
        stepsLog:
          "[Step 1/5 - reflect]\nLet me think about the route.\n\n[Step 2/5 - conclude]\nI propose starting at Fushimi Inari.",
      } as any,
    ]);
    // The conclude message is visible before the final message arrives...
    expect(queryAllByText("I propose starting at Fushimi Inari.", { exact: false }).length).toBe(1);
    expect(queryByText("conclude")).toBeTruthy();
    // ...with dots below while the route JSON is being generated.
    expect(container.querySelectorAll(".typing-dot").length).toBe(3);
  });

  it("does not duplicate the conclude message once the final message arrives", () => {
    const { container, queryAllByText } = renderWith([
      {
        kind: "message",
        name: "Mika",
        turn: 3,
        content: "I propose starting at Fushimi Inari.",
        stepsLabel: "participate",
        maxSteps: 5,
        stepsLog:
          "[Step 1/5 - reflect]\nLet me think about the route.\n\n[Step 2/5 - conclude]\nI propose starting at Fushimi Inari.",
      } as any,
    ]);
    // The conclude step is replaced by the main box — the message shows once.
    expect(queryAllByText("I propose starting at Fushimi Inari.", { exact: false }).length).toBe(1);
    expect(container.querySelectorAll(".typing-dot").length).toBe(0);
  });

  it("shows typing dots below the steps while the next action is being generated", () => {
    const { container, queryByText } = renderWith([
      askStepEntry,
      {
        kind: "ask_exchange",
        turn: 2,
        asker: "Mika",
        target: "Taro",
        question: "Which area do you prefer, Taro?",
        response: "I prefer Higashiyama.",
        pending: false,
      },
    ]);
    // Answer is in, turn not final yet → the asker is "thinking" again.
    expect(queryByText("I prefer Higashiyama.", { exact: false })).toBeTruthy();
    expect(container.querySelectorAll(".typing-dot").length).toBe(3);
  });

  it("shows the awaiting-reply typing dots without a surrounding box", () => {
    const { container } = renderWith([
      {
        kind: "message",
        name: "Mika",
        turn: 4,
        content: "",
        stepsLabel: "participate",
      } as any,
    ]);
    const dot = container.querySelector(".typing-dot");
    expect(dot).toBeTruthy();
    expect(container.querySelectorAll(".typing-dot").length).toBe(3);
    // The dots are bare — not wrapped in a bordered box.
    expect(dot!.closest(".border.border-outline")).toBeNull();
  });

  it("shows the retry warning to the right of the conclude badge", () => {
    const { container, queryByText, queryByLabelText } = renderWith([
      {
        kind: "message",
        name: "Mika",
        turn: 5,
        content: "Let's begin at Kinkaku-ji.",
        stepsLabel: "participate",
        maxSteps: 5,
        retryInfo: { attempt: 2, maxAttempts: 3, errorMessage: "bad json" },
      } as any,
    ]);
    // Retry marker rendered next to the conclude badge, showing the count.
    const marker = queryByLabelText("Retry 2 of 3");
    expect(marker).toBeTruthy();
    expect(queryByText("2/3")).toBeTruthy();
    expect(queryByText("conclude")).toBeTruthy();
    // The marker sits in the same badge row as the conclude label.
    const badgeRow = queryByText("conclude")!.parentElement;
    expect(badgeRow!.contains(marker!)).toBe(true);
    // No leftover retry marker in the header (name row).
    expect(container.querySelectorAll('[aria-label="Retry 2 of 3"]').length).toBe(1);
  });

  it("shows the top fade while no speaker row is pinned", () => {
    const { container } = renderWith([askStepEntry]);
    // With nothing scrolled/pinned, the top edge fade is present...
    const fade = container.querySelector(".bg-gradient-to-b.top-0");
    expect(fade).toBeTruthy();
    // ...and no below-header fade is rendered yet.
    expect(container.querySelector(".bg-gradient-to-b.top-full")).toBeNull();
  });

  it("makes the speaker row sticky so it pins while scrolling the turn", () => {
    const { getByText } = renderWith([
      {
        kind: "message",
        name: "Mika",
        turn: 7,
        content: "A long turn to scroll through.",
        stepsLabel: "participate",
        maxSteps: 5,
      } as any,
    ]);
    // The header row (avatar + name + Turn N) is sticky-positioned at the top.
    const header = getByText("Mika").closest(".sticky");
    expect(header).toBeTruthy();
    expect(header!.className).toContain("top-0");
    // The turn label lives in the same sticky row.
    expect(header!.textContent).toContain("Turn 7");
  });

  it("tags the route Proposal with the retry warning beside it", () => {
    const { queryByText, queryByLabelText } = renderWith([
      {
        kind: "message",
        name: "Mika",
        turn: 6,
        content: "Here's my proposed route.",
        stepsLabel: "participate",
        maxSteps: 5,
        retryInfo: { attempt: 1, maxAttempts: 3, errorMessage: "bad json" },
        routePlan: {
          route: ["Kinkaku-ji", "Ryoan-ji"],
          destinations: [
            { name: "Kinkaku-ji" },
            { name: "Ryoan-ji" },
          ],
        },
      } as any,
    ]);
    // The route carries a "Proposal" tag...
    const tag = queryByText("Proposal");
    expect(tag).toBeTruthy();
    // ...with the retry marker in the same header row, just to its right.
    const marker = queryByLabelText("Retry 1 of 3");
    expect(marker).toBeTruthy();
    expect(tag!.parentElement!.contains(marker!)).toBe(true);
  });

  it("shows Time window / Total cost / Destinations summary cards", () => {
    const { queryByText } = renderWith([
      {
        kind: "message",
        name: "Mika",
        turn: 9,
        content: "Here's my proposed route.",
        stepsLabel: "participate",
        maxSteps: 5,
        routePlan: {
          route: ["A", "B", "C"],
          destinations: [{ name: "A" }, { name: "B" }, { name: "C" }],
          summary: { time_window: "09:00-17:00", total_cost: "¥3,000" },
        },
      } as any,
    ]);
    expect(queryByText("Time window")).toBeTruthy();
    expect(queryByText("Total cost")).toBeTruthy();
    expect(queryByText("Destinations")).toBeTruthy();
    // The Destinations card shows the count (3) — scope to the card since the
    // number also appears on the third destination's badge.
    expect(queryByText("Destinations")!.parentElement!.textContent).toContain("3");
    expect(queryByText("Total duration")).toBeNull();
  });

  it("shows a transport icon for a matched mode, arrow+text otherwise", () => {
    const { queryByLabelText, queryByText } = renderWith([
      {
        kind: "message",
        name: "Mika",
        turn: 10,
        content: "Route",
        stepsLabel: "participate",
        maxSteps: 5,
        routePlan: {
          route: ["A", "B", "C"],
          destinations: [
            { name: "A" },
            { name: "B", transport_mode: "Bus", travel_time_from_previous: "15 min" },
            { name: "C", transport_mode: "Ferry", travel_time_from_previous: "20 min" },
          ],
        },
      } as any,
    ]);
    // Matched mode → icon (aria-label), no mode text.
    expect(queryByLabelText("Bus")).toBeTruthy();
    expect(queryByText("Bus")).toBeNull();
    // Unmatched mode → arrow + raw label text.
    expect(queryByText("Ferry")).toBeTruthy();
    expect(queryByLabelText("Ferry")).toBeNull();
  });

  it("shows the retry marker beside the typing dots while regenerating", () => {
    const { queryByLabelText } = renderWith([
      {
        kind: "message",
        name: "Mika",
        turn: 5,
        content: "",
        stepsLabel: "participate",
        retryInfo: { attempt: 1, maxAttempts: 3, errorMessage: "bad json" },
      } as any,
    ]);
    const marker = queryByLabelText("Retry 1 of 3");
    expect(marker).toBeTruthy();
    // The marker rides in the same row as the dots — not up under the name.
    expect(marker!.parentElement!.querySelector(".typing-dot")).toBeTruthy();
  });

  it("pops in step boxes that stream in after mount, but not history", () => {
    const ref = React.createRef<HTMLDivElement>();
    const endRef = React.createRef<HTMLDivElement>();
    const make = (logs: LogEntry[]) => (
      <ChatMessages
        logs={logs}
        expandedObservations={{}}
        setExpandedObservations={vi.fn()}
        chatContainerRef={ref}
        handleChatScroll={vi.fn()}
        logsEndRef={endRef}
        showScrollButton={false}
        scrollToBottom={vi.fn()}
        routeScrollPositionsRef={{ current: {} }}
        avatars={{ Taro: null }}
      />
    );
    const { container, rerender } = render(make([askStepEntry]));
    // Boxes present at mount (history) don't pop.
    expect(container.querySelector(".chat-pop")).toBeNull();
    rerender(
      make([
        askStepEntry,
        {
          kind: "message",
          name: "Taro",
          turn: 3,
          content: "",
          stepsLabel: "participate",
          stepsLog: "[Step 1/5 - reflect]\nThinking about the route.",
        } as any,
      ])
    );
    // The freshly streamed reflect step box pops in...
    const popped = container.querySelectorAll(".chat-pop");
    expect(popped.length).toBeGreaterThan(0);
    // ...while the history-loaded ask box still doesn't.
    expect(popped[0].textContent).toContain("Thinking about the route.");
  });

  it("tags the route Proposal with no retry marker when it did not retry", () => {
    const { queryByText, queryByLabelText } = renderWith([
      {
        kind: "message",
        name: "Mika",
        turn: 8,
        content: "Here's my proposed route.",
        stepsLabel: "participate",
        maxSteps: 5,
        routePlan: {
          route: ["Kinkaku-ji", "Ryoan-ji"],
          destinations: [{ name: "Kinkaku-ji" }, { name: "Ryoan-ji" }],
        },
      } as any,
    ]);
    expect(queryByText("Proposal")).toBeTruthy();
    expect(queryByLabelText(/^Retry/)).toBeNull();
  });

  it("renders an ask answer as a threaded reply to the asker (no quote)", () => {
    const { container, queryByText } = renderWith([
      askStepEntry,
      {
        kind: "ask_exchange",
        turn: 2,
        asker: "Mika",
        target: "Taro",
        question: "Which area do you prefer, Taro?",
        response: "I prefer Higashiyama.",
        pending: false,
      },
    ]);
    // The answer reads as a reply pointing back at the asker, with the answer.
    expect(container.textContent).toContain("replied to Mika");
    expect(queryByText("I prefer Higashiyama.", { exact: false })).toBeTruthy();
    // No inline quote block is rendered.
    const hasQuote = [...container.querySelectorAll(".truncate")].some((el) =>
      el.textContent?.startsWith("Mika:")
    );
    expect(hasQuote).toBe(false);
  });

  it("strips the raw [Steps]/[Message] log from a conclude message", () => {
    const { container, queryByText, queryAllByText } = renderWith([
      {
        kind: "message",
        name: "Mika",
        turn: 11,
        stepsLabel: "participate",
        maxSteps: 5,
        content:
          "[Steps]\n[Step 1/5 - reflect]\nThinking about balance.\n\n[Message]\nLet's finalize the Plaça route.",
        stepsLog: "[Step 1/5 - reflect]\nThinking about balance.",
      } as any,
    ]);
    // The spoken statement (after [Message]) shows; the raw markers do not.
    expect(queryByText("Let's finalize the Plaça route.", { exact: false })).toBeTruthy();
    expect(container.textContent).not.toContain("[Message]");
    expect(container.textContent).not.toContain("[Steps]");
    expect(container.textContent).not.toContain("[Step 1/5");
    // The reflect step (from stepsLog) still renders once with its thought.
    expect(queryAllByText("Thinking about balance.", { exact: false }).length).toBe(1);
  });

  it("shows the ask and judge tags (and the nested answer) on a vote reply", () => {
    const { container, queryByText } = renderWith([
      {
        kind: "message",
        name: "Amina",
        turn: 1,
        content: "Morning walk pitch.",
        stepsLabel: "free conversation turn",
        routePlan: { route: ["Old Town"], destinations: [{ name: "Old Town" }] },
      } as any,
      {
        kind: "message",
        name: "Isabella",
        turn: 2,
        stepsLabel: "accept",
        maxSteps: 5,
        content:
          "[Steps]\n[Step 1/5 - ask]\nWhich galleries?\nAsk: Amina\nAskQ: Which galleries?\nAskA: The Museu d'Història.\n\n[Message]\nGreat plan — I'm in.",
        stepsLog:
          "[Step 1/5 - ask]\nWhich galleries?\nAsk: Amina\nAskQ: Which galleries?\nAskA: The Museu d'Història.",
      } as any,
    ]);
    // The vote carries its reasoning tags, just like a normal turn.
    const badges = [...container.querySelectorAll("span")].map((s) => s.textContent?.trim());
    expect(badges).toContain("ask");
    expect(badges).toContain("judge");
    // The ask step threads the target's answer back as its own reply.
    expect(container.textContent).toContain("replied to Isabella");
    expect(queryByText("The Museu d'Història.", { exact: false })).toBeTruthy();
    // The vote statement (after [Message]) and its verdict still show.
    expect(queryByText("Great plan — I'm in.", { exact: false })).toBeTruthy();
    expect(queryByText("Accept")).toBeTruthy();
    // The raw markers are stripped from the shown comment.
    expect(container.textContent).not.toContain("[Message]");
  });

  it("chains sequential voters straight down from the first voter's avatar", () => {
    const proposalAndVotes = [
      {
        kind: "message",
        name: "Amina",
        turn: 1,
        content: "Morning walk pitch.",
        stepsLabel: "free conversation turn",
        routePlan: { route: ["Old Town"], destinations: [{ name: "Old Town" }] },
      } as any,
      { kind: "message", name: "Luca", turn: 2, content: "In.", stepsLabel: "accept" } as any,
      { kind: "message", name: "Isabella", turn: 3, content: "Also in.", stepsLabel: "accept" } as any,
      { kind: "message", name: "Taro", turn: 4, content: "Me too.", stepsLabel: "accept" } as any,
    ];
    const { container } = renderWith(proposalAndVotes);
    // Three vote replies threaded under the one proposal.
    const replies = (container.textContent || "").match(/voted on Amina's route/g) || [];
    expect(replies.length).toBe(3);
    // Only the first voter elbows off the proposal; the rest hang on straight
    // rules running avatar-to-avatar (two rules for three voters).
    expect(container.querySelectorAll(".rounded-bl-md").length).toBe(1);
    expect(container.querySelectorAll(".left-12.border-l-2").length).toBe(2);
  });

  it("shows bare dots and no replied-to chip while a vote is still generating", () => {
    const { container } = renderWith([
      {
        kind: "message",
        name: "Amina",
        turn: 1,
        content: "Morning walk pitch.",
        stepsLabel: "free conversation turn",
        routePlan: { route: ["Old Town"], destinations: [{ name: "Old Town" }] },
      } as any,
      // A scoring vote with nothing produced yet: no steps, no comment, no score.
      { kind: "message", name: "Luca", turn: 2, content: "", stepsLabel: "scoring" } as any,
    ]);
    // The reply card shows frameless typing dots — no judge bubble/tag yet.
    const dots = container.querySelectorAll(".typing-dot");
    expect(dots.length).toBe(3);
    expect(dots[0].closest(".bg-surface-secondary")).toBeNull();
    expect(container.textContent).not.toContain("judge");
    // And the vote chip waits for the judge box itself.
    expect(container.textContent).not.toContain("replied to");
    expect(container.textContent).not.toContain("voted on");
  });

  it("appends the bot tally card once the proposal outcome is known", () => {
    const { container, queryByText } = renderWith([
      {
        kind: "message",
        name: "Amina",
        turn: 1,
        content: "Morning walk pitch.",
        stepsLabel: "free conversation turn",
        routePlan: { route: ["Old Town"], destinations: [{ name: "Old Town" }] },
      } as any,
      { kind: "phase", title: "1st Proposal Voting", description: "" } as any,
      { kind: "message", name: "Luca", turn: 2, content: "In.", stepsLabel: "accept" } as any,
      { kind: "message", name: "Isabella", turn: 3, content: "Also in.", stepsLabel: "accept" } as any,
      { kind: "phase", title: "1st Proposal Accepted", description: "" } as any,
    ]);
    // The bot announces the outcome first, then lays out who voted which way
    // (the proposer's implicit accept included under majority) and the rule's
    // arithmetic.
    expect(queryByText("System")).toBeTruthy();
    expect(container.textContent).toContain("Amina's route was accepted!");
    expect(container.querySelector('[aria-label="Accepted"]')).toBeTruthy();
    expect(container.textContent).toContain("Luca, Isabella, Amina (proposer)");
    expect(container.textContent).toContain("Voting rule: majority");
    expect(container.textContent).toContain("Accept (3)");
    expect(container.textContent).toContain("Reject (0)");
    // With the bot in the final slot, both voters chain onward (sequential):
    // two straight avatar-to-avatar rules lead down to the bot.
    expect(container.querySelectorAll(".left-12.border-l-2").length).toBe(2);
  });

  it("replaces the consensus banner with a System card re-showing the final route", () => {
    const { container, queryByText } = renderWith([
      {
        kind: "message",
        name: "Amina",
        turn: 1,
        content: "Proposal.",
        stepsLabel: "free conversation turn",
        routePlan: { route: ["Old Town"], destinations: [{ name: "Old Town" }] },
      } as any,
      { kind: "message", name: "Luca", turn: 2, content: "Happy with it.", stepsLabel: "satisfied" } as any,
      { kind: "phase", title: "Consensus Reached", description: "All satisfied." } as any,
    ]);
    // A top-level System box announces it, with the final route re-shown
    // below a divider under a "Final route" tag…
    expect(queryByText("System")).toBeTruthy();
    expect(queryByText("Consensus Reached!")).toBeTruthy();
    expect(queryByText("Final route")).toBeTruthy();
    // …and the old full-width banner (uppercase h2) is gone.
    expect(container.querySelector("h2")).toBeNull();
    // The System box sits on the speaker line: trunks run Amina→Luca→System.
    expect(container.querySelectorAll(".left-5.border-l-2").length).toBe(2);
    // Not a nested reply — no "replied to" chip anywhere.
    expect(container.textContent).not.toContain("replied to");
  });

  it("keeps the vote thread botless until the outcome arrives", () => {
    const { queryByText } = renderWith([
      {
        kind: "message",
        name: "Amina",
        turn: 1,
        content: "Morning walk pitch.",
        stepsLabel: "free conversation turn",
        routePlan: { route: ["Old Town"], destinations: [{ name: "Old Town" }] },
      } as any,
      { kind: "phase", title: "1st Proposal Voting", description: "" } as any,
      { kind: "message", name: "Luca", turn: 2, content: "In.", stepsLabel: "accept" } as any,
    ]);
    expect(queryByText("System")).toBeNull();
  });

  it("nests an in-progress vote under the proposal during the voting phase", () => {
    const { container } = renderWith([
      {
        kind: "message",
        name: "Amina",
        turn: 1,
        content: "Morning walk pitch.",
        stepsLabel: "free conversation turn",
        routePlan: { route: ["Old Town"], destinations: [{ name: "Old Town" }] },
      } as any,
      { kind: "phase", title: "1st Proposal Voting", description: "" } as any,
      // Still generating: no stepsLabel, no content yet.
      { kind: "message", name: "Luca", turn: 2, content: "" } as any,
    ]);
    // Only the proposal renders a top-level speaker box; the pending voter is
    // already threaded under it, showing bare typing dots.
    expect(container.querySelectorAll(".sticky.top-0").length).toBe(1);
    expect(container.querySelectorAll(".typing-dot").length).toBe(3);
    expect(container.textContent).toContain("Luca");
  });

  it("gives every parallel voter a rounded branch off one shared trunk", () => {
    const { container } = renderWith(
      [
        {
          kind: "message",
          name: "Amina",
          turn: 1,
          content: "Morning walk pitch.",
          stepsLabel: "free conversation turn",
          routePlan: { route: ["Old Town"], destinations: [{ name: "Old Town" }] },
        } as any,
        { kind: "message", name: "Luca", turn: 2, content: "In.", stepsLabel: "accept" } as any,
        { kind: "message", name: "Isabella", turn: 3, content: "Also in.", stepsLabel: "accept" } as any,
        { kind: "message", name: "Taro", turn: 4, content: "Me too.", stepsLabel: "accept" } as any,
      ],
      true
    );
    // Every voter gets the rounded L, and the trunk keeps running past the
    // middle voters (two pass-through trunks for three voters); no straight
    // voter-to-voter chain in parallel mode.
    expect(container.querySelectorAll(".rounded-bl-md").length).toBe(3);
    expect(container.querySelectorAll(".left-3.-top-2.-bottom-2").length).toBe(2);
    expect(container.querySelectorAll(".left-12.border-l-2").length).toBe(0);
  });

  it("threads consecutive speakers together but leaves a lone speaker unconnected", () => {
    const twoSpeakers = renderWith([
      { kind: "message", name: "Amina", turn: 1, content: "First.", stepsLabel: "participate" } as any,
      { kind: "message", name: "Luca", turn: 2, content: "Second.", stepsLabel: "participate" } as any,
    ]);
    // The earlier speaker box draws the vertical rule down to the next speaker.
    expect(twoSpeakers.container.querySelector(".left-5.border-l-2")).toBeTruthy();

    const lone = renderWith([
      { kind: "message", name: "Amina", turn: 1, content: "Only one.", stepsLabel: "participate" } as any,
    ]);
    // A single speaker has nothing to connect to, so no rule is drawn.
    expect(lone.container.querySelector(".left-5.border-l-2")).toBeNull();
  });

  it("runs the speaker connector through satisfied pills and cycle rules", () => {
    const { container } = renderWith([
      { kind: "message", name: "Amina", turn: 1, content: "First.", stepsLabel: "participate" } as any,
      {
        kind: "satisfied_update",
        speaker: "Amina",
        satisfied: true,
        satisfiedCount: 1,
        totalCount: 2,
      } as any,
      { kind: "round_end", roundNumber: 1 } as any,
      { kind: "message", name: "Luca", turn: 2, content: "Second.", stepsLabel: "participate" } as any,
      {
        kind: "satisfied_update",
        speaker: "Luca",
        satisfied: true,
        satisfiedCount: 2,
        totalCount: 2,
      } as any,
    ]);
    // Amina's box still draws the trunk despite the dividers in between.
    expect(container.querySelectorAll(".left-5.border-l-2").length).toBe(1);
    // The satisfied pill and the cycle rule each carry a pass-through segment
    // (the rule's sits left of its inset bar so the two never cross)...
    expect(container.querySelectorAll(".left-1.border-l-2").length).toBe(1);
    expect(container.querySelectorAll(".-left-8.border-l-2").length).toBe(1);
    // ...but the trailing satisfied pill (no speaker after it) does not, so
    // exactly two segments exist even though three dividers render.
    expect(
      (container.textContent || "").includes("Luca is satisfied (2/2)")
    ).toBe(true);
  });

  it("threads votes under the proposal and hides the voting/result banners", () => {
    const { container, queryByText } = renderWith([
      {
        kind: "message",
        name: "Amina",
        turn: 1,
        content: "Morning walk pitch through the old town.",
        stepsLabel: "free conversation turn",
        routePlan: { route: ["Old Town"], destinations: [{ name: "Old Town" }] },
      } as any,
      {
        kind: "phase",
        title: "1st Proposal Voting",
        description: "Amina's proposal is being voted on.",
      } as any,
      {
        kind: "message",
        name: "Luca",
        turn: 2,
        content: "Great plan — I'm in.",
        stepsLabel: "accept",
      } as any,
      {
        kind: "proposal_vote_result",
        turn: 2,
        proposer: "Amina",
        accepted: true,
        voteSummary: { total_votes: 1 },
      } as any,
    ]);
    // The vote reads as a vote on the proposer's route, with its verdict.
    expect(container.textContent).toContain("voted on Amina's route");
    expect(queryByText("Great plan — I'm in.", { exact: false })).toBeTruthy();
    expect(queryByText("Accept")).toBeTruthy();
    // The voting banner and the result banner are dropped.
    expect(queryByText(/Proposal Voting/i)).toBeNull();
    expect(queryByText(/Proposal Accepted/i)).toBeNull();
    // The voter has no standalone sticky speaker row (only the proposer does).
    const stickyNames = [...container.querySelectorAll(".sticky.top-0")].map(
      (el) => el.querySelector(".font-semibold")?.textContent
    );
    expect(stickyNames).toContain("Amina");
    expect(stickyNames).not.toContain("Luca");
  });

  it("threads a Proposal Skipped notice under the proposal as a System reply", () => {
    const { container, queryByText, queryByLabelText } = renderWith([
      {
        kind: "message",
        name: "Amina",
        turn: 1,
        content: "Just one stop, quick and easy.",
        stepsLabel: "free conversation turn",
        routePlan: { route: ["Old Town"], destinations: [{ name: "Old Town" }] },
      } as any,
      {
        kind: "phase",
        title: "Proposal Skipped",
        description: "Amina's proposal was skipped (insufficient destinations).",
      } as any,
    ]);
    // System replies to the proposer with the skip reason (amber icon).
    expect(container.textContent).toContain("replied to Amina");
    expect(
      queryByText("Amina's proposal was skipped (insufficient destinations).")
    ).toBeTruthy();
    expect(queryByLabelText("Proposal skipped")).toBeTruthy();
    expect(container.querySelectorAll('[aria-label="System avatar"]').length).toBe(1);
    // No standalone banner (no uppercase heading).
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelector("h3")).toBeNull();
  });

  it("renders remaining phase banners as top-level System speaker boxes", () => {
    const { container, queryByText } = renderWith([
      {
        kind: "phase",
        title: "Route Proposal",
        description: "Participants propose initial routes.",
      } as any,
      {
        kind: "message",
        name: "Amina",
        turn: 1,
        content: "Here's my idea.",
        stepsLabel: "free conversation turn",
      } as any,
    ]);
    // System speaks the phase title + description in a chat bubble...
    expect(queryByText("Route Proposal")).toBeTruthy();
    expect(queryByText("Participants propose initial routes.")).toBeTruthy();
    expect(container.querySelectorAll('[aria-label="System avatar"]').length).toBe(1);
    // ...instead of the old uppercase band.
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelector("h3")).toBeNull();
    // As a speaker box it threads down to the next speaker on the trunk line.
    expect(container.querySelectorAll(".left-5.border-l-2").length).toBe(1);
  });
});

describe("ChatMessages human ask", () => {
  it("renders the human's own ask inline in their step box (no standalone card)", () => {
    // The human (default name "You") asks Taro. Like an LLM participant, the
    // ask streams into the human turn's steps_log and renders inline — the
    // question as the step, the answer threaded beneath — not a top-level card.
    const { queryByText, queryAllByText } = renderWith([
      {
        kind: "message",
        name: "You",
        turn: 3,
        content: "Thanks, that helps.",
        stepsLog:
          "[Step 1/3 - ask]\nWhat is your budget, Taro?\nAsk: Taro\nAskA: Around $100.",
      } as any,
    ]);
    // Question shows once (as the step), answer threaded under Taro.
    expect(queryAllByText("What is your budget, Taro?", { exact: false }).length).toBe(1);
    expect(queryByText("Around $100.", { exact: false })).toBeTruthy();
    // No standalone "X asked Y" card.
    expect(queryByText(/asked/)).toBeNull();
  });

  it("shows the ask question with typing dots while the answer is pending", () => {
    const { container, queryByText } = renderWith([
      {
        kind: "message",
        name: "You",
        turn: 3,
        content: "",
        stepsLog: "[Step 1/3 - ask]\nWhat is your budget, Taro?\nAsk: Taro",
      } as any,
    ]);
    expect(queryByText("What is your budget, Taro?", { exact: false })).toBeTruthy();
    expect(container.querySelectorAll(".typing-dot").length).toBeGreaterThan(0);
  });
});
