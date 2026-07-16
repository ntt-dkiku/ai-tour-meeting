import React, { useState } from "react";
import { Loader2, Download, RefreshCw } from "lucide-react";
import type { ApiProvider, ApiMessage } from "../types";
import { API_PROVIDERS, API_PROVIDER_LABELS } from "../constants";
import type { IntegrationMode, OllamaModel } from "../hooks/useIntegrations";

interface ApiSettingsModalProps {
  showApiSettings: boolean;
  apiKeyStatus: Record<ApiProvider, { configured: boolean; masked_key: string | null }>;
  apiKeyInputs: Record<ApiProvider, string>;
  apiKeyMessages: Record<ApiProvider, ApiMessage>;
  apiKeyLoading: Record<ApiProvider, boolean>;
  apiBase: string;
  onClose: () => void;
  onApiKeyInputChange: (provider: ApiProvider, value: string) => void;
  onApiKeySave: (provider: ApiProvider) => void;
  integrations: IntegrationMode | null;
  ollamaModels: OllamaModel[];
  ollamaLoading: boolean;
  refreshIntegrations: () => Promise<void>;
}

export default function ApiSettingsModal({
  showApiSettings,
  apiKeyStatus,
  apiKeyInputs,
  apiKeyMessages,
  apiKeyLoading,
  apiBase,
  onClose,
  onApiKeyInputChange,
  onApiKeySave,
  integrations,
  ollamaModels,
  ollamaLoading,
  refreshIntegrations,
}: ApiSettingsModalProps) {
  const [pullModelName, setPullModelName] = useState("");
  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState<string>("");

  const pullOllamaModel = async () => {
    if (!pullModelName.trim()) return;

    setPullingModel(pullModelName);
    setPullProgress("Starting pull...");

    try {
      const response = await fetch(`${apiBase}/ollama/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_name: pullModelName }),
      });

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value);
          const lines = text.split("\n").filter((line) => line.trim());

          for (const line of lines) {
            try {
              const progress = JSON.parse(line);
              if (progress.error) {
                setPullProgress(`Error: ${progress.error}`);
              } else if (progress.status) {
                setPullProgress(progress.status);
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }

        setPullProgress("Pull completed!");
        setPullModelName("");
        setTimeout(() => {
          setPullingModel(null);
          setPullProgress("");
          refreshIntegrations();
        }, 2000);
      }
    } catch (error) {
      setPullProgress(`Error: ${error}`);
      setTimeout(() => {
        setPullingModel(null);
        setPullProgress("");
      }, 3000);
    }
  };

  if (!showApiSettings) {
    return null;
  }

  const ollamaInstances = integrations?.ollama ?? [];
  const ollamaEnabled = ollamaInstances.length > 0;
  const ollamaConnected = ollamaInstances.some((i) => i.connected);
  const vllmInstances = integrations?.vllm ?? [];
  const vllmEnabled = vllmInstances.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-surface w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl shadow-xl p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-on-surface">LLM Settings</h3>
          <button
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center rounded-lg border border-outline text-on-surface-tertiary hover:text-on-surface-secondary hover:border-outline-secondary transition-colors"
            aria-label="Close settings"
          >
            <span className="text-xl leading-none">&times;</span>
          </button>
        </div>
        <div>
          <h4 className="text-sm font-semibold text-on-surface mb-3">Commercial LLMs</h4>
          <div className="space-y-2">
            {API_PROVIDERS.map((provider) => {
              const status = apiKeyStatus[provider];
              const message = apiKeyMessages[provider];
              const loading = apiKeyLoading[provider];
              return (
                <div key={provider}>
                  <div className="flex items-center gap-3">
                    <div className="w-28 shrink-0 flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${status.configured ? "bg-emerald-500" : "bg-zinc-300"}`} />
                      <span className="text-sm font-medium text-on-surface">
                        {API_PROVIDER_LABELS[provider]}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0 relative">
                      <input
                        type="password"
                        className="w-full rounded-md bg-surface-secondary border-0 px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-tertiary/60 focus:outline-none focus:ring-2 focus:ring-zinc-400/40 transition-shadow"
                        placeholder={status.configured && status.masked_key
                          ? status.masked_key
                          : `Enter ${API_PROVIDER_LABELS[provider]} API key`}
                        value={apiKeyInputs[provider]}
                        onChange={(e) => onApiKeyInputChange(provider, e.target.value)}
                      />
                    </div>
                    <button
                      onClick={() => onApiKeySave(provider)}
                      disabled={loading}
                      className={`shrink-0 self-stretch inline-flex items-center gap-1 px-3 rounded-md text-sm font-medium transition-all ${
                        loading
                          ? "text-on-surface-tertiary cursor-not-allowed"
                          : "text-on-surface-secondary hover:text-on-surface hover:bg-surface-secondary"
                      }`}
                    >
                      {loading ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : null}
                      Save
                    </button>
                  </div>
                  {message ? (
                    <p
                      className={`text-xs mt-1 ml-[7.5rem] ${
                        message.type === "error" ? "text-red-500" : "text-emerald-600"
                      }`}
                    >
                      {message.message}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {/* Local LLMs */}
        <div className="border-t pt-6 space-y-4">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-on-surface">Local LLMs</h4>
            <button
              onClick={() => refreshIntegrations()}
              disabled={ollamaLoading}
              className="p-1 rounded text-on-surface-tertiary hover:text-on-surface-secondary transition-colors disabled:opacity-50"
              aria-label="Refresh local LLM status"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${ollamaLoading ? "animate-spin" : ""}`} />
            </button>
          </div>

          {/* Enabled: Ollama instances */}
          {ollamaEnabled && (
            <div className="space-y-3">
              <div className="space-y-2">
                {ollamaInstances.map((inst) => (
                  <div key={inst.index} className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${inst.connected ? "bg-emerald-500" : "bg-amber-500"}`} />
                    <span className="text-sm font-medium text-on-surface">
                      Ollama{ollamaInstances.length > 1 ? ` #${inst.index}` : ""}
                    </span>
                    {inst.gpus.length > 0 && (
                      <span className="text-sm text-on-surface-secondary">
                        GPU {inst.gpus.join(",")}
                      </span>
                    )}
                    {!inst.connected && (
                      <span className="text-xs text-amber-600">Unreachable</span>
                    )}
                  </div>
                ))}
              </div>

              {/* Pull + installed models */}
              {ollamaConnected && (
                <div className="space-y-3 pl-[0.875rem]">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      className="flex-1 rounded-md bg-surface-secondary border-0 px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-tertiary/60 focus:outline-none focus:ring-2 focus:ring-zinc-400/40 transition-shadow"
                      placeholder="Pull model (e.g. llama3, mistral)"
                      value={pullModelName}
                      onChange={(e) => setPullModelName(e.target.value)}
                      disabled={!!pullingModel}
                      onKeyPress={(e) => {
                        if (e.key === "Enter") pullOllamaModel();
                      }}
                    />
                    <button
                      onClick={pullOllamaModel}
                      disabled={!pullModelName.trim() || !!pullingModel}
                      className="shrink-0 self-stretch inline-flex items-center gap-1 px-3 rounded-md text-sm font-medium transition-all text-on-surface-secondary hover:text-on-surface hover:bg-surface-secondary disabled:text-on-surface-tertiary disabled:cursor-not-allowed"
                    >
                      {pullingModel ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Download className="w-3.5 h-3.5" />
                      )}
                      Pull
                    </button>
                  </div>
                  {pullProgress && (
                    <p className="text-xs text-on-surface-tertiary">{pullProgress}</p>
                  )}
                  {ollamaLoading ? (
                    <div className="flex items-center justify-center py-4 text-on-surface-tertiary">
                      <Loader2 className="w-4 h-4 animate-spin" />
                    </div>
                  ) : ollamaModels.length === 0 ? (
                    <p className="text-xs text-on-surface-tertiary py-2">No models installed.</p>
                  ) : (
                    <div className="max-h-40 overflow-y-auto space-y-1">
                      {ollamaModels.map((model) => (
                        <div key={model.name} className="flex items-baseline justify-between rounded-md bg-surface-secondary px-3 py-2">
                          <span className="text-sm font-medium text-on-surface">{model.name}</span>
                          <span className="text-xs text-on-surface-tertiary">{(model.size / 1024 / 1024 / 1024).toFixed(1)} GB</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Enabled: vLLM instances */}
          {vllmEnabled && (
            <div className="space-y-2">
              {vllmInstances.map((inst) => (
                <div key={inst.index}>
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${inst.connected ? "bg-emerald-500" : "bg-amber-500"}`} />
                    <span className="text-sm font-medium text-on-surface">
                      vLLM{vllmInstances.length > 1 ? ` #${inst.index}` : ""}
                    </span>
                    {!inst.connected && (
                      <span className="text-xs text-amber-600">Unreachable</span>
                    )}
                  </div>
                  {(inst.serving || inst.model) && (
                    <div className="text-sm text-on-surface-secondary pl-[0.875rem] mt-0.5">
                      {inst.gpus.length > 0 ? `GPU ${inst.gpus.join(",")}: ` : ""}{inst.serving || inst.model}
                    </div>
                  )}
                  {!inst.connected && (
                    <p className="text-xs text-amber-600 pl-[0.875rem] mt-0.5">
                      Server is not responding. It may still be loading the model.
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Disabled */}
          {!ollamaEnabled && (
            <div>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-zinc-300" />
                <span className="text-sm font-medium text-on-surface-tertiary">Ollama</span>
              </div>
              <p className="text-xs text-on-surface-tertiary pl-[0.875rem] mt-1">
                Start with <code className="bg-surface-secondary px-1 py-0.5 rounded text-xs">make up OLLAMA=cpu</code> or <code className="bg-surface-secondary px-1 py-0.5 rounded text-xs">make up OLLAMA=gpu</code> to enable.
              </p>
            </div>
          )}
          {!vllmEnabled && (
            <div>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-zinc-300" />
                <span className="text-sm font-medium text-on-surface-tertiary">vLLM</span>
              </div>
              <p className="text-xs text-on-surface-tertiary pl-[0.875rem] mt-1">
                Start with <code className="bg-surface-secondary px-1 py-0.5 rounded text-xs">make up VLLM=Qwen/Qwen3-8B</code> to enable.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
