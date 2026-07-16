import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ImagePlus, Info, Palette, RotateCcw, Shuffle, X } from "lucide-react";
import type { AvatarShape, ParticipantIn } from "../../types";
import type { IntegrationMode, OllamaModel } from "../../hooks/useIntegrations";
import CharacterAvatar from "../CharacterAvatar";
import { COMMERCIAL_MODELS, buildModelOptions } from "../../constants";
import {
  AVATAR_FACE_COUNT,
  AVATAR_PALETTES,
  AVATAR_SHAPES,
  avatarForName,
  fileToAvatarImage,
  isNameDerivedAvatar,
  randomAvatar,
} from "../../utils/avatar";

const getDefaultTemperatureForModel = (modelName: string): number =>
  modelName.startsWith("openai/gpt-5") ? 1 : 0.7;

interface ParticipantModalProps {
  showModal: boolean;
  editingParticipant: { index: number; data: ParticipantIn } | null;
  form: ParticipantIn;
  setForm: (form: ParticipantIn) => void;
  participantError: string;
  onClose: () => void;
  onSave: () => void;
  integrations?: IntegrationMode | null;
  ollamaModels?: OllamaModel[];
  apiBase: string;
  /** View-only mode: all fields disabled, no save button (locked meetings). */
  readOnly?: boolean;
}

const ParticipantModal: React.FC<ParticipantModalProps> = ({
  showModal,
  editingParticipant,
  form,
  setForm,
  participantError,
  onClose,
  onSave,
  integrations,
  ollamaModels = [],
  apiBase,
  readOnly = false,
}) => {
  const ollamaInstances = integrations?.ollama ?? [];
  const vllmInstances = integrations?.vllm ?? [];

  const getVllmMaxModelLen = (modelName: string): number | null => {
    if (!modelName.startsWith("vllm/")) return null;
    for (const inst of vllmInstances) {
      if (inst.max_model_len && modelName.includes(inst.serving ?? "")) {
        return inst.max_model_len;
      }
    }
    return null;
  };

  const getDefaultMaxTokens = (modelName: string): number | null => {
    if (modelName.startsWith("anthropic/")) return 8192;
    if (modelName.startsWith("vllm/")) return 8192;
    if (!modelName.startsWith("openai/") && !modelName.startsWith("google/") && !modelName.startsWith("ollama/")) return 8192;
    return null;
  };

  const fetchModelInfo = async (
    modelName: string,
    currentForm: ParticipantIn,
    setFn: (f: ParticipantIn) => void,
  ) => {
    try {
      const res = await fetch(`${apiBase}/models/info?model=${encodeURIComponent(modelName)}`);
      if (!res.ok) return;
      const info: { max_input_tokens: number | null; max_output_tokens: number | null } = await res.json();
      const updates: Partial<ParticipantIn> = {};
      if (info.max_output_tokens != null) updates.max_tokens = info.max_output_tokens;
      if (info.max_input_tokens != null) updates.max_context_length = info.max_input_tokens;
      if (Object.keys(updates).length > 0) {
        setFn({ ...currentForm, ...updates });
      }
    } catch {
      // ignore – user can still set values manually
    }
  };

  const allKnownModels = useMemo(
    () => buildModelOptions(integrations ?? null, ollamaModels),
    [integrations, ollamaModels]
  );

  const [customMode, setCustomMode] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [avatarError, setAvatarError] = useState<string>("");
  // Whether the avatar was set explicitly (upload / shuffle / custom). While
  // false, the avatar tracks the Name (so the same name → the same character).
  const [avatarManual, setAvatarManual] = useState(false);
  const [showCustom, setShowCustom] = useState(false);

  const handleUploadClick = () => fileInputRef.current?.click();
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setAvatarError("Please choose an image file.");
      return;
    }
    try {
      const src = await fileToAvatarImage(file);
      setForm({ ...form, avatar: { kind: "image", src } });
      setAvatarManual(true);
      setShowCustom(false);
      setAvatarError("");
    } catch {
      setAvatarError("Could not load that image.");
    }
  };

  // Revert to the Name-derived character (re-enables Name tracking).
  const resetAvatar = () => {
    setForm((f) => ({ ...f, avatar: avatarForName(f.name) }));
    setAvatarManual(false);
    setShowCustom(false);
  };
  // A fresh fully-random character.
  const shuffleAvatar = () => {
    setForm((f) => ({ ...f, avatar: randomAvatar() }));
    setAvatarManual(true);
    setShowCustom(false);
  };
  // Open the manual customizer, converting an image/none avatar to a generated one.
  const openCustom = () => {
    setForm((f) =>
      f.avatar && f.avatar.kind === "generated"
        ? f
        : { ...f, avatar: avatarForName(f.name) }
    );
    setAvatarManual(true);
    setShowCustom((v) => !v);
  };
  // Apply a partial change (shape / palette / face / custom colour) to the
  // generated avatar. Picking a palette clears any custom colour, and vice versa.
  const setGen = (partial: {
    shape?: AvatarShape;
    palette?: number;
    face?: number;
    color?: string;
  }) => {
    setForm((f) => {
      const base =
        f.avatar && f.avatar.kind === "generated" ? f.avatar : avatarForName(f.name);
      return {
        ...f,
        avatar: {
          kind: "generated" as const,
          shape: partial.shape ?? base.shape,
          palette: partial.palette ?? base.palette,
          face: partial.face ?? base.face,
          // palette selection drops the custom colour; a colour set overrides it
          color:
            partial.palette !== undefined ? undefined : partial.color ?? base.color,
        },
      };
    });
    setAvatarManual(true);
  };

  // Sync custom mode and auto-fill max_context_length when modal opens
  useEffect(() => {
    if (showModal) {
      setCustomMode(
        form.model_name !== "" && !allKnownModels.includes(form.model_name)
      );
      const updates: Partial<ParticipantIn> = {};
      // Seed a Name-derived avatar if none is set. An avatar that was actually
      // customized (upload / shuffle / custom) is treated as manual and kept;
      // a default Name-derived one keeps tracking the Name, so renaming (e.g. a
      // duplicated participant) updates the icon as expected.
      if (!form.avatar) {
        updates.avatar = avatarForName(form.name);
      }
      setAvatarManual(!!form.avatar && !isNameDerivedAvatar(form.avatar, form.name));
      setShowCustom(false);
      if (form.max_tokens == null) {
        const defaultTokens = getDefaultMaxTokens(form.model_name);
        if (defaultTokens != null) updates.max_tokens = defaultTokens;
      }
      if (form.max_context_length == null) {
        const maxModelLen = getVllmMaxModelLen(form.model_name);
        if (maxModelLen != null) {
          const outTokens = updates.max_tokens ?? form.max_tokens ?? 8192;
          updates.max_context_length = Math.max(0, maxModelLen - outTokens);
        }
      }
      const newForm = Object.keys(updates).length > 0 ? { ...form, ...updates } : form;
      if (newForm !== form) setForm(newForm);
      // Auto-fill from litellm for commercial models when tokens are not set
      const mn = form.model_name;
      if (
        (mn.startsWith("openai/") || mn.startsWith("google/") || mn.startsWith("anthropic/")) &&
        form.max_tokens == null && form.max_context_length == null
      ) {
        fetchModelInfo(mn, newForm, setForm);
      }
    }
  }, [showModal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const expected = getDefaultTemperatureForModel(form.model_name || "");
    if (form.temperature !== expected) {
      setForm({ ...form, temperature: expected });
    }
  }, [form.model_name, form.temperature]); // eslint-disable-line react-hooks/exhaustive-deps

  const modelWarning = useMemo(() => {
    if (form.model_name.startsWith("ollama/") && integrations) {
      const anyConnected = ollamaInstances.some((inst) => inst.connected);
      if (!anyConnected) {
        return "No Ollama instances are connected. This model will not be available.";
      }
    }
    if (form.model_name.startsWith("vllm/") && integrations) {
      const anyConnected = vllmInstances.some((inst) => inst.connected);
      if (!anyConnected) {
        return "No vLLM instances are connected. This model will not be available.";
      }
    }
    return null;
  }, [form.model_name, integrations, ollamaInstances, vllmInstances]);

  const inputClass =
    "w-full rounded-md bg-surface-secondary border-0 px-3 py-2.5 text-sm text-on-surface placeholder:text-on-surface-tertiary/60 focus:outline-none focus:ring-2 focus:ring-zinc-400/40 transition-shadow";
  const selectInputClass =
    "w-full appearance-none rounded-md bg-surface-secondary border-0 px-3 py-2.5 pr-8 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-zinc-400/40 transition-shadow";

  if (!showModal) {
    return null;
  }

  const canSave = form.name && form.background && form.personality && form.preferences && form.personal_goals;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-surface w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl shadow-xl p-6 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-on-surface">
            {readOnly ? "Participant details" : editingParticipant ? "Edit participant" : "Participant"}
          </h3>
          <button
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center rounded-lg border border-outline text-on-surface-tertiary hover:text-on-surface-secondary hover:border-outline-secondary transition-colors"
            aria-label="Close"
          >
            <span className="text-xl leading-none">&times;</span>
          </button>
        </div>

        {/* All form fields; disabling the fieldset makes them view-only. */}
        <fieldset disabled={readOnly} className="space-y-5 border-0 p-0 m-0 min-w-0">

        {/* Identity */}
        <div className="space-y-3">
          {/* Avatar */}
          {(() => {
            const genBase =
              form.avatar && form.avatar.kind === "generated"
                ? form.avatar
                : avatarForName(form.name);
            const btnClass =
              "inline-flex items-center justify-center gap-1.5 rounded-md bg-surface-secondary px-3 text-xs text-on-surface-secondary transition-all duration-150 hover:text-on-surface hover:-translate-y-0.5 hover:shadow active:translate-y-0 active:shadow-none";
            const currentBody =
              genBase.color ?? AVATAR_PALETTES[genBase.palette]?.body ?? "#7FB2F0";
            return (
              <div className="space-y-2">
                <div className="flex items-start gap-4">
                  <CharacterAvatar
                    avatar={form.avatar}
                    name={form.name}
                    size={64}
                    className="flex-shrink-0"
                  />
                  {/* 2×2 grid, fixed width (so it never stretches) and its two
                      rows spanning the avatar's height */}
                  <div className="grid h-16 w-64 grid-cols-2 grid-rows-2 gap-2">
                    <button type="button" onClick={handleUploadClick} className={btnClass}>
                      <ImagePlus className="w-3.5 h-3.5" /> Upload
                    </button>
                    <button type="button" onClick={resetAvatar} className={btnClass}>
                      <RotateCcw className="w-3.5 h-3.5" /> Reset
                    </button>
                    <button type="button" onClick={shuffleAvatar} className={btnClass}>
                      <Shuffle className="w-3.5 h-3.5" /> Shuffle
                    </button>
                    <button
                      type="button"
                      onClick={openCustom}
                      className={`${btnClass} ${showCustom ? "ring-1 ring-zinc-400/50 text-on-surface" : ""}`}
                    >
                      <Palette className="w-3.5 h-3.5" /> Custom
                    </button>
                  </div>
                </div>
                {avatarError && <p className="text-xs text-red-500">{avatarError}</p>}
                {showCustom && (
                  <div className="space-y-2 rounded-md bg-surface-secondary/60 p-2">
                    {/* Shape */}
                    <div className="flex items-center gap-2">
                      <span className="w-11 text-xs text-on-surface-tertiary">Shape</span>
                      {AVATAR_SHAPES.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setGen({ shape: s })}
                          className={`rounded-md p-0.5 transition-colors ${
                            genBase.shape === s
                              ? "ring-2 ring-zinc-500/60"
                              : "hover:bg-surface-tertiary"
                          }`}
                          aria-label={s}
                        >
                          <CharacterAvatar
                            avatar={{ kind: "generated", shape: s, palette: genBase.palette, face: genBase.face, color: genBase.color }}
                            size={26}
                          />
                        </button>
                      ))}
                    </div>
                    {/* Color */}
                    <div className="flex items-center gap-2">
                      <span className="w-11 text-xs text-on-surface-tertiary">Color</span>
                      {AVATAR_PALETTES.map((p, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setGen({ palette: i })}
                          style={{ backgroundColor: p.body }}
                          className={`h-5 w-5 rounded-full transition-transform ${
                            !genBase.color && genBase.palette === i
                              ? "ring-2 ring-offset-1 ring-zinc-500/70 ring-offset-surface"
                              : "hover:scale-110"
                          }`}
                          aria-label={`color ${i + 1}`}
                        />
                      ))}
                      {/* Custom RGB colour */}
                      <label
                        title="Custom colour"
                        className={`relative h-5 w-5 cursor-pointer overflow-hidden rounded-full transition-transform ${
                          genBase.color
                            ? "ring-2 ring-offset-1 ring-zinc-500/70 ring-offset-surface"
                            : "hover:scale-110"
                        }`}
                        style={
                          genBase.color
                            ? { backgroundColor: genBase.color }
                            : {
                                background:
                                  "conic-gradient(from 0deg, #f87171, #fbbf24, #34d399, #60a5fa, #a78bfa, #f472b6, #f87171)",
                              }
                        }
                      >
                        <input
                          type="color"
                          value={currentBody}
                          onChange={(e) => setGen({ color: e.target.value })}
                          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                        />
                      </label>
                    </div>
                    {/* Face */}
                    <div className="flex items-center gap-2">
                      <span className="w-11 text-xs text-on-surface-tertiary">Face</span>
                      {Array.from({ length: AVATAR_FACE_COUNT }).map((_, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setGen({ face: i })}
                          className={`rounded-md p-0.5 transition-colors ${
                            genBase.face === i
                              ? "ring-2 ring-zinc-500/60"
                              : "hover:bg-surface-tertiary"
                          }`}
                          aria-label={`face ${i + 1}`}
                        >
                          <CharacterAvatar
                            avatar={{ kind: "generated", shape: genBase.shape, palette: genBase.palette, face: i, color: genBase.color }}
                            size={26}
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </div>
            );
          })()}
          <div>
            <label className="block text-sm font-medium text-on-surface mb-1">Name</label>
            <input
              className={inputClass}
              placeholder="Enter participant name"
              value={form.name}
              onChange={(e) => {
                const name = e.target.value;
                // While the avatar isn't manually set, keep it derived from the name.
                setForm((f) => ({
                  ...f,
                  name,
                  avatar: avatarManual ? f.avatar : avatarForName(name),
                }));
              }}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-on-surface mb-1">Background</label>
            <textarea
              className={`${inputClass} resize-none`}
              placeholder="Relevant context, experience, or situation"
              rows={2}
              value={form.background}
              onChange={(e) => setForm({ ...form, background: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-on-surface mb-1">Personality</label>
            <textarea
              className={`${inputClass} resize-none`}
              placeholder="Stable traits, e.g. cautious, curious, analytical, sociable"
              rows={2}
              value={form.personality}
              onChange={(e) => setForm({ ...form, personality: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-on-surface mb-1">Preferences</label>
            <textarea
              className={`${inputClass} resize-none`}
              placeholder="Likes, dislikes, priorities, and constraints"
              rows={2}
              value={form.preferences}
              onChange={(e) => setForm({ ...form, preferences: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-on-surface mb-1">Personal goals</label>
            <textarea
              className={`${inputClass} resize-none`}
              placeholder="What should this participant focus on?"
              rows={2}
              value={form.personal_goals}
              onChange={(e) => setForm({ ...form, personal_goals: e.target.value })}
            />
          </div>
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <label className="text-sm font-medium text-on-surface">
                Custom system prompt <span className="text-on-surface-tertiary font-normal">(optional)</span>
              </label>
              <span className="relative group cursor-help">
                <Info className="w-3.5 h-3.5 text-on-surface-tertiary" />
                <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-72 px-2 py-1.5 text-[11px] leading-snug bg-zinc-800 text-white rounded shadow-lg whitespace-normal text-left opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                  {"Overrides the default system prompt when set; leave empty to use the default. Supports placeholders: {name}, {background}, {personality}, {preferences}, {personal_goals}, {role}, {speaking_style}, {explanation_style}, {meeting_title}, {meeting_goals}, {meeting_workflow}, {other_participants}, {constraints_text}. Unused placeholders are left as-is."}
                </span>
              </span>
            </div>
            <textarea
              className={`${inputClass} resize-y font-mono text-xs`}
              placeholder="Leave empty to use the default."
              rows={4}
              value={form.system_prompt ?? ""}
              onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
            />
          </div>
        </div>

        {/* Behavior */}
        <div className="border-t pt-5 space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1">Role</label>
              <div className="relative">
                <select
                  className={selectInputClass}
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                >
                  <option value="attendee">Attendee</option>
                  <option value="facilitator">Facilitator</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-on-surface-tertiary" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1">Speaking style</label>
              <input
                className={inputClass}
                placeholder="friendly"
                value={form.speaking_style}
                onChange={(e) => setForm({ ...form, speaking_style: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1">Explanation</label>
              <div className="relative">
                <select
                  className={selectInputClass}
                  value={form.explanation_style}
                  onChange={(e) => setForm({ ...form, explanation_style: e.target.value })}
                >
                  <option value="auto">Auto</option>
                  <option value="subjective">Subjective</option>
                  <option value="contrastive">Contrastive</option>
                  <option value="both">Both</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-on-surface-tertiary" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1">Web search</label>
              <button
                type="button"
                onClick={() => setForm({ ...form, web_search: !form.web_search })}
                className={`w-full rounded-md py-[calc(0.625rem-1px)] text-sm font-medium transition-all ${
                  form.web_search
                    ? "bg-accent text-white border border-accent"
                    : "bg-surface-secondary text-on-surface-tertiary border border-dashed border-outline hover:text-on-surface-secondary"
                }`}
              >
                {form.web_search ? "On" : "Off"}
              </button>
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1">Max steps per turn</label>
              <input
                type="number"
                min={1}
                max={50}
                className={inputClass}
                value={form.max_steps}
                onChange={(e) => setForm({ ...form, max_steps: Number(e.target.value) })}
              />
            </div>
          </div>
        </div>

        {/* Model */}
        <div className="border-t pt-5 space-y-3">
          <div>
            <label className="block text-sm font-medium text-on-surface mb-1">Model</label>
            <div className="flex gap-2">
            <div className="min-w-0 flex-1">
            {customMode ? (
              <div className="relative">
                <input
                  className={`${inputClass} pr-8`}
                  placeholder="e.g., openai/gpt-4o"
                  value={form.model_name}
                  onChange={(e) => {
                    const newModel = e.target.value;
                    setForm({
                      ...form,
                      model_name: newModel,
                      temperature: getDefaultTemperatureForModel(newModel),
                    });
                  }}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => {
                    setCustomMode(false);
                    const newModel = COMMERCIAL_MODELS[0];
                    setForm({
                      ...form,
                      model_name: newModel,
                      temperature: getDefaultTemperatureForModel(newModel),
                    });
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-on-surface-tertiary hover:text-accent transition-colors"
                  title="Back to model list"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="relative">
                <select
                  className={selectInputClass}
                  value={form.model_name}
                  onChange={(e) => {
                    if (e.target.value === "custom") {
                      setCustomMode(true);
                      setForm({ ...form, model_name: "", temperature: 0.7 });
                    } else {
                      const newModel = e.target.value;
                      const updates: Partial<ParticipantIn> = {
                        model_name: newModel,
                        temperature: getDefaultTemperatureForModel(newModel),
                      };
                      const defaultTokens = getDefaultMaxTokens(newModel);
                      updates.max_tokens = defaultTokens;
                      const maxModelLen = getVllmMaxModelLen(newModel);
                      if (maxModelLen != null) {
                        const outTokens = defaultTokens ?? 8192;
                        updates.max_context_length = Math.max(0, maxModelLen - outTokens);
                      } else {
                        updates.max_context_length = null;
                      }
                      const newForm = { ...form, ...updates };
                      setForm(newForm);
                      // Auto-fill token limits from litellm for commercial models
                      if (newModel.startsWith("openai/") || newModel.startsWith("google/") || newModel.startsWith("anthropic/")) {
                        fetchModelInfo(newModel, newForm, setForm);
                      }
                    }
                  }}
                >
                  <optgroup label="Commercial">
                    {COMMERCIAL_MODELS.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </optgroup>
                  {vllmInstances.length === 1 && vllmInstances[0].serving && (
                    <optgroup label="vLLM">
                      {(() => {
                        const inst = vllmInstances[0];
                        const gpuLabel = inst.gpus.length > 0 ? ` (GPU ${inst.gpus.join(",")})` : "";
                        const value = `vllm/${inst.serving}`;
                        return (
                          <option key={value} value={value}>
                            vllm/{inst.serving}{gpuLabel}
                          </option>
                        );
                      })()}
                    </optgroup>
                  )}
                  {vllmInstances.length > 1 && vllmInstances.some((inst) => inst.serving) && (
                    vllmInstances
                      .filter((inst) => inst.serving)
                      .map((inst) => {
                        const gpuLabel = inst.gpus.length > 0 ? ` (GPU ${inst.gpus.join(",")})` : "";
                        const value = `vllm/${inst.index}/${inst.serving}`;
                        return (
                          <optgroup key={value} label={`vLLM${gpuLabel}`}>
                            <option value={value}>
                              vllm/{inst.serving}{gpuLabel}
                            </option>
                          </optgroup>
                        );
                      })
                  )}
                  {ollamaInstances.length === 1 && ollamaModels.length > 0 && (
                    <optgroup label="Ollama">
                      {ollamaModels.map((m) => (
                        <option key={m.name} value={`ollama/${m.name}`}>
                          ollama/{m.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {ollamaInstances.length > 1 && ollamaModels.length > 0 && (
                    ollamaInstances.map((inst) => {
                      const gpuLabel = inst.gpus.length > 0 ? ` (GPU ${inst.gpus.join(",")})` : "";
                      return (
                        <optgroup key={inst.index} label={`Ollama${gpuLabel}`}>
                          {ollamaModels.map((m) => (
                            <option key={`${inst.index}-${m.name}`} value={`ollama/${inst.index}/${m.name}`}>
                              ollama/{m.name}{gpuLabel}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })
                  )}
                  <optgroup label="Other">
                    <option value="custom">Custom</option>
                  </optgroup>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-on-surface-tertiary" />
              </div>
            )}
            </div>
            {(form.model_name || "").startsWith("openai/gpt-5") && (
              <div className="relative w-28 shrink-0" title="Reasoning effort (gpt-5 family)">
                <select
                  className={selectInputClass}
                  value={form.reasoning_effort ?? "medium"}
                  onChange={(e) => setForm({ ...form, reasoning_effort: e.target.value })}
                >
                  <option value="none">none</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-on-surface-tertiary" />
              </div>
            )}
            </div>
            {(form.model_name || "").startsWith("openai/gpt-5") && (
              <p className="mt-1 text-xs text-on-surface-tertiary">Reasoning effort: medium is the validated default; none disables reasoning.</p>
            )}
            {modelWarning && (
              <p className="mt-1.5 text-xs text-amber-600">{modelWarning}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1">Temperature</label>
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                className={inputClass}
                value={form.temperature}
                onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1">Seed</label>
              <input
                type="number"
                className={inputClass}
                value={form.seed}
                onChange={(e) => setForm({ ...form, seed: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1">Max input tokens</label>
              <input
                type="number"
                min={1024}
                step={1024}
                className={inputClass}
                placeholder="Default"
                value={form.max_context_length ?? ""}
                onChange={(e) => setForm({ ...form, max_context_length: e.target.value ? Number(e.target.value) : null })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1">Max output tokens</label>
              <input
                type="number"
                min={1}
                step={256}
                className={inputClass}
                placeholder="Default"
                value={form.max_tokens ?? ""}
                onChange={(e) => {
                  const newMaxTokens = e.target.value ? Number(e.target.value) : null;
                  const maxModelLen = getVllmMaxModelLen(form.model_name);
                  const newContext = maxModelLen != null
                    ? Math.max(0, maxModelLen - (newMaxTokens ?? 8192))
                    : form.max_context_length;
                  setForm({ ...form, max_tokens: newMaxTokens, max_context_length: newContext });
                }}
              />
            </div>
          </div>
        </div>

        {/* Context Management */}
        <div className="border-t pt-5 space-y-3">
          <div>
            <label className="text-sm font-medium text-on-surface">Context management</label>
            <select
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-on-surface"
              value={form.context_mode}
              onChange={(e) => setForm({ ...form, context_mode: e.target.value as "truncate" | "fixed_turns" | "auto_compact" })}
            >
              <option value="truncate">Truncate</option>
              <option value="fixed_turns">Fixed turns</option>
              <option value="auto_compact">Auto compact</option>
            </select>
          </div>

          {form.context_mode === "fixed_turns" ? (
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-sm font-medium text-on-surface">Keep last N turns</label>
                <span className="relative group cursor-help">
                  <Info className="w-3.5 h-3.5 text-on-surface-tertiary" />
                  <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-[11px] bg-zinc-800 text-white rounded shadow-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                    Only keep the most recent N turns in history
                  </span>
                </span>
              </div>
              <input
                type="number"
                min={1}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-on-surface"
                value={form.fixed_turns_count}
                onChange={(e) => setForm({ ...form, fixed_turns_count: Math.max(1, Number(e.target.value) || 1) })}
              />
            </div>
          ) : (
            <>
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <label className="text-sm font-medium text-on-surface">
                    {form.context_mode === "truncate" ? "Truncate trigger" : "Compact trigger"}
                  </label>
                  <span className="relative group cursor-help">
                    <Info className="w-3.5 h-3.5 text-on-surface-tertiary" />
                    <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-[11px] bg-zinc-800 text-white rounded shadow-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                      {form.context_mode === "truncate"
                        ? "Truncate oldest messages when input tokens reach this % of Max Input Tokens"
                        : "Compact when input tokens reach this % of Max Input Tokens"}
                    </span>
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={0.1}
                    max={1.0}
                    step={0.05}
                    className="flex-1 accent-zinc-600 dark:accent-zinc-400"
                    value={form.auto_compact_threshold}
                    onChange={(e) => setForm({ ...form, auto_compact_threshold: Number(e.target.value) })}
                  />
                  <span className="text-sm font-mono text-on-surface-secondary w-12 text-right">
                    {Math.round(form.auto_compact_threshold * 100)}%
                  </span>
                </div>
              </div>
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <label className="text-sm font-medium text-on-surface">
                    {form.context_mode === "truncate" ? "Truncate target" : "Compact target"}
                  </label>
                  <span className="relative group cursor-help">
                    <Info className="w-3.5 h-3.5 text-on-surface-tertiary" />
                    <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-[11px] bg-zinc-800 text-white rounded shadow-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                      {form.context_mode === "truncate"
                        ? "Keep input tokens down to this % of Max Input Tokens (oldest messages removed first)"
                        : "Compress input tokens to this % of Max Input Tokens"}
                    </span>
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={0.1}
                    max={1.0}
                    step={0.05}
                    className="flex-1 accent-zinc-600 dark:accent-zinc-400"
                    value={form.auto_compact_target}
                    onChange={(e) => setForm({ ...form, auto_compact_target: Number(e.target.value) })}
                  />
                  <span className="text-sm font-mono text-on-surface-secondary w-12 text-right">
                    {Math.round(form.auto_compact_target * 100)}%
                  </span>
                </div>
              </div>

              {/* Recent Ratio (auto_compact only) */}
              {form.context_mode === "auto_compact" && (
                <div>
                  <div className="flex items-center gap-1.5 mb-1">
                    <label className="text-sm font-medium text-on-surface">
                      Keep recent ratio
                    </label>
                    <span className="relative group cursor-help">
                      <Info className="w-3.5 h-3.5 text-on-surface-tertiary" />
                      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-[11px] bg-zinc-800 text-white rounded shadow-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                        Portion of target budget reserved for recent messages (remainder is used for summary)
                      </span>
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={0.1}
                      max={0.9}
                      step={0.05}
                      className="flex-1 accent-zinc-600 dark:accent-zinc-400"
                      value={form.compact_recent_ratio}
                      onChange={(e) => setForm({ ...form, compact_recent_ratio: Number(e.target.value) })}
                    />
                    <span className="text-sm font-mono text-on-surface-secondary w-12 text-right">
                      {Math.round(form.compact_recent_ratio * 100)}%
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        </fieldset>

        {/* Error */}
        {!readOnly && participantError && (
          <p className="text-xs text-red-500">{participantError}</p>
        )}

        {/* Action */}
        {!readOnly && (
          <button
            onClick={onSave}
            disabled={!canSave}
            className={`w-full py-2.5 rounded-lg text-sm font-medium transition-all ${
              canSave
                ? "bg-accent text-white hover:bg-accent-hover active:scale-[0.98]"
                : "bg-surface-secondary text-on-surface-tertiary cursor-not-allowed"
            }`}
          >
            {editingParticipant ? "Save changes" : "Add participant"}
          </button>
        )}
      </div>
    </div>
  );
};

export default ParticipantModal;
