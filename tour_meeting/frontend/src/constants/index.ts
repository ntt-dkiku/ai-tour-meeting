import type { ApiProvider, ParticipantIn, ApiMessage } from "../types";
import type { IntegrationMode, OllamaModel } from "../hooks/useIntegrations";

// Default values
export const DEFAULT_GLOBAL_GOAL = "Plan a one-day sightseeing tour in Kyoto.";

export const DOCUMENTATION_URL =
  import.meta.env.DEV
    ? "/docs/index.html"
    : import.meta.env.VITE_DOCUMENTATION_URL || "https://ntt-dkiku.github.io/tour-meeting-private/";

// Model options
export const COMMERCIAL_MODELS = [
  "openai/gpt-5.4-mini",
  "google/gemini-1.5-pro-latest",
  "anthropic/claude-3-5-sonnet-20241022",
];

export interface ModelOption {
  value: string;
  label: string;
}

export interface ModelOptionGroup {
  label: string;
  options: ModelOption[];
}

// Builds the selectable models grouped the same way as ParticipantModal's
// Model <select> (Commercial, then one group per vllm / ollama instance with
// GPU labels), so every model picker in the app shows the same structure.
export const buildModelOptionGroups = (
  integrations: IntegrationMode | null | undefined,
  ollamaModels: OllamaModel[]
): ModelOptionGroup[] => {
  const ollamaInstances = integrations?.ollama ?? [];
  const vllmInstances = integrations?.vllm ?? [];
  const gpuLabel = (inst: { gpus: number[] }) =>
    inst.gpus.length > 0 ? ` (GPU ${inst.gpus.join(",")})` : "";

  const groups: ModelOptionGroup[] = [
    { label: "Commercial", options: COMMERCIAL_MODELS.map((m) => ({ value: m, label: m })) },
  ];
  if (vllmInstances.length === 1) {
    const inst = vllmInstances[0];
    if (inst.serving) {
      groups.push({
        label: "vLLM",
        options: [{ value: `vllm/${inst.serving}`, label: `vllm/${inst.serving}${gpuLabel(inst)}` }],
      });
    }
  } else {
    for (const inst of vllmInstances) {
      if (inst.serving) {
        groups.push({
          label: `vLLM${gpuLabel(inst)}`,
          options: [
            { value: `vllm/${inst.index}/${inst.serving}`, label: `vllm/${inst.serving}${gpuLabel(inst)}` },
          ],
        });
      }
    }
  }
  if (ollamaInstances.length === 1) {
    if (ollamaModels.length > 0) {
      groups.push({
        label: "Ollama",
        options: ollamaModels.map((m) => ({ value: `ollama/${m.name}`, label: `ollama/${m.name}` })),
      });
    }
  } else {
    for (const inst of ollamaInstances) {
      if (ollamaModels.length > 0) {
        groups.push({
          label: `Ollama${gpuLabel(inst)}`,
          options: ollamaModels.map((m) => ({
            value: `ollama/${inst.index}/${m.name}`,
            label: `ollama/${m.name}${gpuLabel(inst)}`,
          })),
        });
      }
    }
  }
  return groups;
};

// Flat list of the same model ids (ParticipantModal's `allKnownModels`
// derives from this, keeping the two pickers in sync).
export const buildModelOptions = (
  integrations: IntegrationMode | null | undefined,
  ollamaModels: OllamaModel[]
): string[] =>
  buildModelOptionGroups(integrations, ollamaModels).flatMap((g) =>
    g.options.map((o) => o.value)
  );

// API providers
export const API_PROVIDERS: ApiProvider[] = ["openai", "anthropic", "google"];

export const API_PROVIDER_LABELS: Record<ApiProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};

export const createApiStatusState = () => {
  const base: Record<ApiProvider, { configured: boolean; masked_key: string | null }> = {
    openai: { configured: false, masked_key: null },
    anthropic: { configured: false, masked_key: null },
    google: { configured: false, masked_key: null },
  };
  return base;
};

export const createApiInputState = () => ({
  openai: "",
  anthropic: "",
  google: "",
} as Record<ApiProvider, string>);

export const createApiLoadingState = () => ({
  openai: false,
  anthropic: false,
  google: false,
} as Record<ApiProvider, boolean>);

export const createApiMessageState = () => ({
  openai: null,
  anthropic: null,
  google: null,
} as Record<ApiProvider, ApiMessage>);

// Form defaults
export const createDefaultParticipantForm = (): ParticipantIn => ({
  model_name: "openai/gpt-5.4-mini",
  temperature: 1,
  reasoning_effort: "medium",
  seed: 42,
  max_tokens: null,
  max_context_length: null,
  context_mode: "auto_compact",
  auto_compact_threshold: 0.8,
  auto_compact_target: 0.5,
  compact_recent_ratio: 0.7,
  fixed_turns_count: 10,
  name: "",
  background: "",
  personality: "",
  preferences: "",
  personal_goals: "",
  role: "attendee",
  speaking_style: "friendly",
  explanation_style: "auto",
  web_search: false,
  max_steps: 5,
  system_prompt: "",
});

// Rule options
export const TURN_RULE_OPTIONS = [
  { value: "round_robin", label: "Round robin" },
  { value: "inviting", label: "Inviting" },
  { value: "facilitating", label: "Facilitating" },
  { value: "random", label: "Random" },
];

export const VOTE_TURN_RULE_OPTIONS = [
  ...TURN_RULE_OPTIONS,
  { value: "parallel", label: "Parallel" },
];

export const VOTING_RULE_OPTIONS = [
  { value: "majority", label: "Majority" },
  { value: "unanimous", label: "Unanimous" },
  { value: "most_pleasure", label: "Most pleasure" },
  { value: "least_misery", label: "Least misery" },
  { value: "single_decider", label: "Single decider" },
];

// UI constants
export const INVITATION_PHASE_TITLES = new Set([
  "Next Speaker Invitation",
  "Facilitator Selected Next Speaker",
]);

export const INTERNAL_EXPANDED_STORAGE_KEY = "tourMeetingInternalExpanded_v1";
export const MEETING_HISTORY_STORAGE_KEY = "tourMeetingHistory_v1";

// Sidebar constants
export const SIDEBAR_WIDTH = 256;
export const COLLAPSED_SIDEBAR_WIDTH = 56;

// Status styles
export const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  idle: { label: "Idle", className: "text-on-surface-tertiary" },
  running: { label: "Live", className: "text-accent font-medium flex items-center gap-1" },
  stopping: { label: "Stopping", className: "text-amber-600 font-medium" },
  finished: { label: "Completed", className: "text-green-600 font-medium" },
  timeout: { label: "Timeout", className: "text-red-500 font-medium" },
  stopped: { label: "Stopped", className: "text-on-surface-tertiary font-medium" },
  error: { label: "Error", className: "text-red-600 font-semibold" },
};

export const getStatusStyle = (status?: string) =>
  STATUS_STYLES[status ?? ""] ?? STATUS_STYLES.idle;

// Time options for start/end time selects
export const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const hour = Math.floor(i / 2);
  const minute = (i % 2) * 30;
  const timeValue = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
  const displayTime = `${hour % 12 || 12}:${minute.toString().padStart(2, "0")}${hour < 12 ? "am" : "pm"}`;
  return { value: timeValue, label: displayTime };
});
