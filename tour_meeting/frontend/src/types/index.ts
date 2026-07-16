// Avatar types — a participant's display icon. Either a procedurally generated
// "halftone character" (shape + color + face, like the home-screen characters)
// or a user-uploaded image (stored inline as a small resized data URL).
export type AvatarShape = "circle" | "square" | "triangle";

export interface GeneratedAvatar {
  kind: "generated";
  shape: AvatarShape;
  palette: number; // index into AVATAR_PALETTES
  face: number; // index into AVATAR_FACES
  color?: string; // optional custom body colour (#rrggbb); overrides the palette
}

export interface ImageAvatar {
  kind: "image";
  src: string; // data URL of a small (resized) thumbnail
}

export type Avatar = GeneratedAvatar | ImageAvatar;

// Participant types
export interface ParticipantIn {
  /** Stable id, unique within the meeting. Assigned by the server on save. */
  id?: string;
  /**
   * Name the live persona speaks under. Equals `name` unless another
   * participant shares it, then a " (2)"-style suffix is added server-side.
   */
  engine_name?: string | null;
  /** Display icon. Absent → derived deterministically from the name. */
  avatar?: Avatar | null;
  model_name: string;
  temperature: number;
  /**
   * Reasoning effort for models that support it (gpt-5 family):
   * "none" | "low" | "medium" | "high". "none"/null omit the parameter.
   */
  reasoning_effort?: string | null;
  seed: number;
  max_tokens?: number | null;
  max_context_length?: number | null;
  context_mode: "truncate" | "fixed_turns" | "auto_compact";
  auto_compact_threshold: number;
  auto_compact_target: number;
  compact_recent_ratio: number;
  fixed_turns_count: number;
  name: string;
  background: string;
  personality: string;
  preferences: string;
  personal_goals: string;
  role: string;
  speaking_style: string;
  explanation_style: "auto" | "subjective" | "contrastive" | "both";
  web_search: boolean;
  max_steps: number;
  // Optional full override of the participant system prompt. Empty/omitted
  // falls back to the default template on the backend.
  system_prompt?: string | null;
  // A still-incomplete draft: stored with the meeting but not run. Shown as an
  // amber card; the meeting can't start until every participant is complete.
  incomplete?: boolean;
}

// API types
export type ApiProvider = "openai" | "anthropic" | "google";

export type ApiMessage = { type: "success" | "error"; message: string } | null;

// Meeting types
export interface MeetingInfo {
  id: string;
  title: string;
  created_at: string;
  participant_count: number;
  has_history: boolean;
  include_human?: boolean;
  human_name?: string;
  human_avatar?: Avatar | null;
  human_role?: string;
  status?: string;
  status_detail?: string | null;
  travel_date?: string | null;
  time_window_start?: string | null;
  time_window_end?: string | null;
  budget?: string | null;
  elapsed_seconds?: number;
}

export interface MeetingSettingsFile {
  version?: number;
  title?: string;
  globalGoals?: string;
  maxTurns?: number;
  timeLimit?: number | string | null;
  travelDate?: string | null;
  timeWindowStart?: string | null;
  timeWindowEnd?: string | null;
  budget?: string | null;
  includeHuman?: boolean;
  order?: string[];
  turnRule?: string;
  votingRule?: string;
  volunteerMode?: boolean;
  balancedTurns?: boolean;
  participants?: ParticipantIn[];
}

export interface MeetingHistory {
  [meetingId: string]: LogEntry[];
}

// Route plan types
export interface RoutePlanDestination {
  name?: string;
  description?: string;
  start_time?: string;
  original_start_time?: string;
  stay_duration?: string;
  travel_time_from_previous?: string;
  transport_mode?: string;
  cost?: string;
  transport_cost?: string;
  diff_status?: "added" | "removed" | "modified" | "unchanged";
}

export interface RoutePlanSummary {
  total_duration?: string;
  stay_duration?: string;
  travel_duration?: string;
  free_time?: string;
  total_cost?: string;
  spots_count?: number;
  time_window?: string;
}

export interface RoutePlan {
  route?: string[];
  destinations?: RoutePlanDestination[];
  summary?: RoutePlanSummary | null;
}

// Internal event types
export interface InternalEventPayload {
  event_type: "thinking_step" | "search_results" | "ask_exchange" | "reflection" | "complete";
  task_label?: string;
  task_focus?: string;
  step_number?: number;
  max_steps?: number;
  action?: string;
  thought?: string;
  working_notes?: string;
  query?: string;
  ask_target?: string;
  observation?: string;
  log?: string;
  // ask_exchange fields
  target?: string;
  question?: string;
  response?: string;
  // reflection fields
  notes?: string;
}

export interface DeltaMetadata {
  internal_event?: InternalEventPayload;
}

export interface InternalStreamState {
  speaker: string;
  turn: number;
  stepNumber?: number;
  maxSteps?: number;
  action?: string;
  taskLabel?: string;
  taskFocus?: string;
  message?: string;
  query?: string;
  eventType: "thinking_step" | "search_results";
}

export interface InternalLogContext {
  log?: string;
  taskLabel?: string;
  replaceLog?: boolean;
  stepNumber?: number;
  action?: string;
}

// Log entry types
export interface SearchSection {
  query: string;
  result?: string;
  searching: boolean;
}

export interface MessageOut {
  kind: "message";
  name: string;
  content: string;
  turn: number;
  turnLabel?: string;
  routePlan?: RoutePlan;
  invitationHighlight?: string;
  invitationMessage?: string;
  stepsLog?: string;
  stepsLabel?: string;
  maxSteps?: number;
  score?: number;
  needModification?: boolean;
  searches?: SearchSection[];
  retryInfo?: {
    attempt: number;
    maxAttempts: number;
    errorMessage: string;
  };
}

export interface PhaseLogEntry {
  kind: "phase";
  title: string;
  description?: string | null;
}

export interface AskExchangeEntry {
  kind: "ask_exchange";
  turn: number;
  asker: string;
  target: string;
  question: string;
  response: string;
  /** True while the answer is still being generated (question shown, no answer yet). */
  pending?: boolean;
}

export interface ProposalVoteResultEntry {
  kind: "proposal_vote_result";
  turn: number;
  proposer: string;
  accepted: boolean;
  voteSummary: Record<string, any>;
}

export interface SatisfiedUpdateEntry {
  kind: "satisfied_update";
  turn: number;
  speaker: string;
  satisfied: boolean;
  satisfiedCount: number;
  totalCount: number;
}

export interface RoundEndEntry {
  kind: "round_end";
  roundNumber: number;
}

export type LogEntry = MessageOut | PhaseLogEntry | AskExchangeEntry | ProposalVoteResultEntry | SatisfiedUpdateEntry | RoundEndEntry;

// WebSocket event types
// `replay` marks events re-sent from the server-side buffer when a client
// (re)attaches to a stream; handlers must treat them idempotently.
export type WsEvent = { replay?: boolean } & (
  | { type: "meeting_started"; goal: string; include_human?: boolean }
  | { type: "turn_start"; turn: number; speaker: string }
  | { type: "delta"; turn: number; speaker: string; delta: string; metadata?: DeltaMetadata }
  | { type: "turn_final"; turn: number; speaker: string; text: string; route_plan?: RoutePlan; steps_log?: string; steps_label?: string; max_steps?: number; score?: number }
  | { type: "phase_message"; title: string; description?: string | null }
  | { type: "route_plan_update"; turn: number; speaker: string; route_plan: RoutePlan }
  | { type: "retry_notification"; turn: number; speaker: string; attempt: number; max_attempts: number; error_message: string }
  | { type: "human_turn"; turn: number; step?: number; max_steps?: number; candidates?: string[]; can_ask?: boolean; can_propose?: boolean; current_route?: RoutePlanDestination[] }
  | { type: "human_vote"; turn: number; vote_type: string; options: any; step?: number; max_steps?: number; candidates?: string[]; can_ask?: boolean }
  | { type: "human_select_speaker"; turn: number; speaker: string; candidates: string[] }
  | { type: "human_ask"; turn: number; asker: string; target: string; question: string }
  | { type: "ask_pending"; turn: number; asker: string; target: string; question: string }
  | { type: "ask_exchange"; turn: number; asker: string; target: string; question: string; response: string }
  | { type: "proposal_vote_result"; turn: number; proposer: string; accepted: boolean; vote_summary: Record<string, any> }
  | { type: "satisfied_update"; turn: number; speaker: string; satisfied: boolean; satisfied_count: number; total_count: number }
  | { type: "round_end"; round_number: number }
  | { type: "timeout" }
  | { type: "meeting_finished"; turns: number }
  | { type: "status"; meeting_id?: string; status?: string; reason?: string | null }
  | { type: "stream_closed"; meeting_id?: string }
  | { type: "error"; message: string }
);

// UI types
export interface ContextMenuState {
  meetingId?: string;
  participantId?: string;
  x: number;
  y: number;
  type: 'meeting' | 'participant' | 'human';
}
