import { useState, useCallback, useEffect } from "react";

export interface OllamaInstance {
  index: number;
  mode: string;
  gpus: number[];
  connected: boolean;
}

export interface VllmInstance {
  index: number;
  enabled: boolean;
  model: string;
  gpus: number[];
  connected: boolean;
  serving: string | null;
  max_model_len: number | null;
}

export interface IntegrationMode {
  ollama: OllamaInstance[];
  vllm: VllmInstance[];
}

export interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
}

export interface UseIntegrationsReturn {
  integrations: IntegrationMode | null;
  ollamaModels: OllamaModel[];
  ollamaLoading: boolean;
  refreshIntegrations: () => Promise<void>;
}

export function useIntegrations(apiBase: string): UseIntegrationsReturn {
  const [integrations, setIntegrations] = useState<IntegrationMode | null>(null);
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [ollamaLoading, setOllamaLoading] = useState(false);

  const fetchIntegrations = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase}/settings/integrations`);
      if (!response.ok) return;
      const data = await response.json();
      if (Array.isArray(data?.ollama) && Array.isArray(data?.vllm)) {
        setIntegrations(data);
      }
    } catch (error) {
      console.error("Failed to fetch integration status:", error);
    }
  }, [apiBase]);

  const fetchOllamaModels = useCallback(async () => {
    setOllamaLoading(true);
    try {
      const response = await fetch(`${apiBase}/ollama/models`);
      const data = await response.json();
      setOllamaModels(data.models || []);
    } catch (error) {
      console.error("Failed to fetch Ollama models:", error);
    } finally {
      setOllamaLoading(false);
    }
  }, [apiBase]);

  const refreshIntegrations = useCallback(async () => {
    await Promise.all([fetchIntegrations(), fetchOllamaModels()]);
  }, [fetchIntegrations, fetchOllamaModels]);

  useEffect(() => {
    refreshIntegrations();
  }, [refreshIntegrations]);

  return {
    integrations,
    ollamaModels,
    ollamaLoading,
    refreshIntegrations,
  };
}
