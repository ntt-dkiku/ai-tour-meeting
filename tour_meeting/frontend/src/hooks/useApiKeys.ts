import { useState, useCallback, useEffect } from "react";
import type { ApiProvider, ApiMessage } from "../types";
import {
  API_PROVIDERS,
  createApiStatusState,
  createApiInputState,
  createApiLoadingState,
  createApiMessageState,
} from "../constants";

export interface UseApiKeysReturn {
  showApiSettings: boolean;
  setShowApiSettings: (show: boolean) => void;
  apiKeyStatus: Record<ApiProvider, { configured: boolean; masked_key: string | null }>;
  apiKeyInputs: Record<ApiProvider, string>;
  apiKeyMessages: Record<ApiProvider, ApiMessage>;
  apiKeyLoading: Record<ApiProvider, boolean>;
  setApiKeyInputs: React.Dispatch<React.SetStateAction<Record<ApiProvider, string>>>;
  fetchApiKeyStatus: () => Promise<void>;
  handleApiKeySave: (provider: ApiProvider) => Promise<void>;
}

export function useApiKeys(apiBase: string): UseApiKeysReturn {
  const [showApiSettings, setShowApiSettings] = useState<boolean>(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<Record<ApiProvider, { configured: boolean; masked_key: string | null }>>(createApiStatusState);
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<ApiProvider, string>>(createApiInputState);
  const [apiKeyLoading, setApiKeyLoading] = useState<Record<ApiProvider, boolean>>(createApiLoadingState);
  const [apiKeyMessages, setApiKeyMessages] = useState<Record<ApiProvider, ApiMessage>>(createApiMessageState);

  const fetchApiKeyStatus = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/settings/api-keys`);
      if (!res.ok) {
        throw new Error("Failed to load API key status");
      }
      const data = await res.json();
      const nextStatus = createApiStatusState();
      API_PROVIDERS.forEach((provider) => {
        if (data && data[provider]) {
          nextStatus[provider] = {
            configured: Boolean(data[provider].configured),
            masked_key: data[provider].masked_key ?? null,
          };
        }
      });
      setApiKeyStatus(nextStatus);
    } catch (err) {
      console.error(err);
    }
  }, [apiBase]);

  const handleApiKeySave = useCallback(
    async (provider: ApiProvider) => {
      const value = apiKeyInputs[provider]?.trim() ?? "";
      if (!value) {
        setApiKeyMessages((prev) => ({
          ...prev,
          [provider]: { type: "error", message: "Please enter an API key." },
        }));
        return;
      }

      setApiKeyLoading((prev) => ({ ...prev, [provider]: true }));
      setApiKeyMessages((prev) => ({ ...prev, [provider]: null }));

      try {
        const res = await fetch(`${apiBase}/settings/api-keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, api_key: value }),
        });

        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          const message = errorData?.detail || "Failed to verify API key.";
          throw new Error(message);
        }

        const payload = await res.json();
        setApiKeyStatus((prev) => ({
          ...prev,
          [provider]: {
            configured: true,
            masked_key: payload?.masked_key ?? null,
          },
        }));
        setApiKeyInputs((prev) => ({ ...prev, [provider]: "" }));
        setApiKeyMessages((prev) => ({
          ...prev,
          [provider]: { type: "success", message: "API key saved successfully." },
        }));
      } catch (err) {
        console.error(err);
        setApiKeyMessages((prev) => ({
          ...prev,
          [provider]: {
            type: "error",
            message: err instanceof Error ? err.message : "Failed to save API key.",
          },
        }));
      } finally {
        setApiKeyLoading((prev) => ({ ...prev, [provider]: false }));
        fetchApiKeyStatus();
      }
    },
    [apiBase, apiKeyInputs, fetchApiKeyStatus]
  );

  // Fetch API key status when settings modal is opened
  useEffect(() => {
    if (showApiSettings) {
      fetchApiKeyStatus();
      setApiKeyInputs(createApiInputState());
      setApiKeyLoading(createApiLoadingState());
      setApiKeyMessages(createApiMessageState());
    }
  }, [showApiSettings, fetchApiKeyStatus]);

  return {
    showApiSettings,
    setShowApiSettings,
    apiKeyStatus,
    apiKeyInputs,
    apiKeyMessages,
    apiKeyLoading,
    setApiKeyInputs,
    fetchApiKeyStatus,
    handleApiKeySave,
  };
}
