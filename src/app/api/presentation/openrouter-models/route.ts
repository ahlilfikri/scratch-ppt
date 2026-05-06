import { env } from "@/env";
import { createLogger } from "@/lib/observability/logger";
import { auth } from "@/server/auth";
import { NextResponse } from "next/server";

interface OpenRouterModel {
  id: string;
  name: string;
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id?: string;
    name?: string;
  }>;
}

const routeLogger = createLogger("api:presentation-openrouter-models");
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_FETCH_TIMEOUT_MS = 5_000;

function createTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  controller.signal.addEventListener("abort", () => clearTimeout(timeout), {
    once: true,
  });
  return controller.signal;
}

async function fetchOpenRouterModels(apiKey: string): Promise<OpenRouterModel[]> {
  const response = await fetch(OPENROUTER_MODELS_URL, {
    cache: "no-store",
    signal: createTimeoutSignal(OPENROUTER_FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter responded with ${response.status}`);
  }

  const payload = (await response.json()) as OpenRouterModelsResponse;
  return (payload.data ?? [])
    .map((model) => {
      const id = model.id?.trim();
      if (!id) {
        return null;
      }
      return {
        id,
        name: model.name?.trim() || id,
      };
    })
    .filter((model): model is OpenRouterModel => model !== null);
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { models: [], configured: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const models = await fetchOpenRouterModels(apiKey);
    return NextResponse.json(
      { models, configured: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    routeLogger.warn("Failed to fetch OpenRouter models", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { models: [], configured: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
