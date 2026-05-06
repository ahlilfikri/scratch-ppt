"use client";

import { createLogger } from "@/lib/observability/logger";
import { useQuery } from "@tanstack/react-query";

export interface OpenRouterModelInfo {
  id: string;
  name: string;
}

interface OpenRouterModelsApiResponse {
  models?: OpenRouterModelInfo[];
  configured?: boolean;
}

const openRouterLogger = createLogger("client:openrouter-models");
const OPENROUTER_MODELS_API_URL = "/api/presentation/openrouter-models";

export const curatedOpenRouterModels: OpenRouterModelInfo[] = [
  { id: "openai/gpt-4o-mini", name: "OpenAI · GPT-4o mini" },
  { id: "openai/gpt-4o", name: "OpenAI · GPT-4o" },
  { id: "anthropic/claude-3.5-sonnet", name: "Anthropic · Claude 3.5 Sonnet" },
  { id: "anthropic/claude-3.5-haiku", name: "Anthropic · Claude 3.5 Haiku" },
  {
    id: "meta-llama/llama-3.1-70b-instruct",
    name: "Meta · Llama 3.1 70B Instruct",
  },
  {
    id: "meta-llama/llama-3.1-8b-instruct",
    name: "Meta · Llama 3.1 8B Instruct",
  },
  { id: "google/gemini-2.0-flash-001", name: "Google · Gemini 2.0 Flash" },
  { id: "deepseek/deepseek-chat", name: "DeepSeek · Chat" },
  {
    id: "mistralai/mistral-large-2411",
    name: "Mistral · Large (2411)",
  },
  { id: "qwen/qwen-2.5-72b-instruct", name: "Qwen · 2.5 72B Instruct" },
];

async function fetchOpenRouterModels(): Promise<{
  models: OpenRouterModelInfo[];
  configured: boolean;
}> {
  try {
    const response = await fetch(OPENROUTER_MODELS_API_URL, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`OpenRouter models API responded with ${response.status}`);
    }

    const payload = (await response.json()) as OpenRouterModelsApiResponse;
    const models = Array.isArray(payload.models) ? payload.models : [];

    openRouterLogger.info("OpenRouter model discovery completed", {
      total: models.length,
      configured: payload.configured ?? false,
    });

    return {
      models,
      configured: payload.configured ?? false,
    };
  } catch (error) {
    openRouterLogger.warn("Failed to refresh OpenRouter models", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { models: [], configured: false };
  }
}

export function useOpenRouterModels() {
  return useQuery({
    queryKey: ["openrouter-models"],
    queryFn: fetchOpenRouterModels,
    staleTime: 10 * 60 * 1000,
    retry: 1,
    retryDelay: 1000,
    select: (data) => {
      const remoteModels = data.models;
      const seen = new Set(remoteModels.map((model) => model.id));
      const merged = [
        ...remoteModels,
        ...curatedOpenRouterModels.filter((model) => !seen.has(model.id)),
      ];
      return {
        models: merged,
        configured: data.configured,
      };
    },
  });
}
