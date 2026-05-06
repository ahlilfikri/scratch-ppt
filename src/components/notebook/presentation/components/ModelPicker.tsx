"use client";

import { createLogger } from "@/lib/observability/logger";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from "@/components/ui/select";
import {
  fallbackModels,
  getSelectedModel,
  setSelectedModel,
  useLocalModels,
} from "@/hooks/presentation/useLocalModels";
import { useOpenRouterModels } from "@/hooks/presentation/useOpenRouterModels";
import { usePresentationState } from "@/states/presentation-state";
import { Bot, Cloud, Cpu, Loader2, Monitor } from "lucide-react";
import { useEffect, useRef } from "react";

const modelPickerLogger = createLogger("client:model-picker");

export function ModelPicker({
  shouldShowLabel = true,
}: {
  shouldShowLabel?: boolean;
}) {
  const { modelProvider, setModelProvider, modelId, setModelId } =
    usePresentationState();

  const { data: modelsData, isLoading, isInitialLoad } = useLocalModels();
  const { data: openRouterData } = useOpenRouterModels();
  const hasRestoredFromStorage = useRef(false);

  useEffect(() => {
    if (!hasRestoredFromStorage.current) {
      const savedModel = getSelectedModel();
      if (savedModel) {
        modelPickerLogger.info("Restoring previously selected model", {
          modelProvider: savedModel.modelProvider,
          modelId: savedModel.modelId || "gpt-4o-mini",
        });
        setModelProvider(
          savedModel.modelProvider as
            | "openai"
            | "ollama"
            | "lmstudio"
            | "openrouter",
        );
        setModelId(savedModel.modelId);
      }
      hasRestoredFromStorage.current = true;
    }
  }, [setModelId, setModelProvider]);

  const openRouterModels = openRouterData?.models ?? [];
  const isOpenRouterConfigured = openRouterData?.configured ?? false;

  const displayData = modelsData || {
    localModels: [],
    downloadableModels: fallbackModels,
    showDownloadable: true,
  };

  const { localModels, downloadableModels, showDownloadable } = displayData;

  const ollamaModels = localModels.filter(
    (model) => model.provider === "ollama",
  );
  const lmStudioModels = localModels.filter(
    (model) => model.provider === "lmstudio",
  );
  const downloadableOllamaModels = downloadableModels.filter(
    (model) => model.provider === "ollama",
  );

  const createModelOption = (
    model: (typeof localModels)[0],
    isDownloadable = false,
  ) => ({
    id: model.id,
    label: model.name,
    displayLabel:
      model.provider === "ollama"
        ? `ollama ${model.name}`
        : `lm-studio ${model.name}`,
    icon: model.provider === "ollama" ? Cpu : Monitor,
    description: isDownloadable
      ? `Downloadable ${model.provider === "ollama" ? "Ollama" : "LM Studio"} model (will auto-download)`
      : `Local ${model.provider === "ollama" ? "Ollama" : "LM Studio"} model`,
  });

  const getCurrentModelValue = () => {
    if (modelProvider === "ollama") {
      return `ollama-${modelId}`;
    }

    if (modelProvider === "lmstudio") {
      return `lmstudio-${modelId}`;
    }

    if (modelProvider === "openrouter") {
      return `openrouter-${modelId}`;
    }

    return "openai";
  };

  const getCurrentModelOption = () => {
    const currentValue = getCurrentModelValue();

    if (currentValue === "openai") {
      return {
        label: "GPT-4o-mini",
        icon: Bot,
      };
    }

    if (currentValue.startsWith("openrouter-")) {
      const orModel = openRouterModels.find(
        (model) => model.id === modelId,
      );
      return {
        label: orModel ? orModel.name : modelId || "OpenRouter",
        icon: Cloud,
      };
    }

    const localModel = localModels.find((model) => model.id === currentValue);
    if (localModel) {
      return {
        label: localModel.name,
        icon: localModel.provider === "ollama" ? Cpu : Monitor,
      };
    }

    const downloadableModel = downloadableModels.find(
      (model) => model.id === currentValue,
    );
    if (downloadableModel) {
      return {
        label: downloadableModel.name,
        icon: downloadableModel.provider === "ollama" ? Cpu : Monitor,
      };
    }

    return {
      label: "Select model",
      icon: Bot,
    };
  };

  const handleModelChange = (value: string) => {
    if (value === "openai") {
      modelPickerLogger.info("Selected OpenAI model", {
        modelProvider: "openai",
        modelId: "gpt-4o-mini",
      });
      setModelProvider("openai");
      setModelId("");
      setSelectedModel("openai", "");
      return;
    }

    if (value.startsWith("openrouter-")) {
      const model = value.replace("openrouter-", "");
      modelPickerLogger.info("Selected OpenRouter model", {
        modelProvider: "openrouter",
        modelId: model,
      });
      setModelProvider("openrouter");
      setModelId(model);
      setSelectedModel("openrouter", model);
      return;
    }

    if (value.startsWith("ollama-")) {
      const model = value.replace("ollama-", "");
      const isDownloadableSelection = downloadableModels.some(
        (candidate) => candidate.id === value,
      );
      modelPickerLogger.info("Selected Ollama model", {
        modelProvider: "ollama",
        modelId: model,
        isDownloadableSelection,
      });
      if (isDownloadableSelection) {
        modelPickerLogger.info(
          "Selected a downloadable Ollama model suggestion; the server will download it on first use if needed",
          {
            modelProvider: "ollama",
            modelId: model,
          },
        );
      }
      setModelProvider("ollama");
      setModelId(model);
      setSelectedModel("ollama", model);
      return;
    }

    if (value.startsWith("lmstudio-")) {
      const model = value.replace("lmstudio-", "");
      modelPickerLogger.info("Selected LM Studio model", {
        modelProvider: "lmstudio",
        modelId: model,
      });
      setModelProvider("lmstudio");
      setModelId(model);
      setSelectedModel("lmstudio", model);
    }
  };

  return (
    <div className="space-y-1.5">
      {shouldShowLabel && (
        <label className="block text-xs font-medium text-muted-foreground">
          Text model
        </label>
      )}
      <Select value={getCurrentModelValue()} onValueChange={handleModelChange}>
        <SelectTrigger className="overflow-hidden bg-background">
          <div className="flex min-w-0 items-center gap-2">
            {(() => {
              const currentOption = getCurrentModelOption();
              const Icon = currentOption.icon;
              return <Icon className="h-4 w-4 flex-shrink-0" />;
            })()}
            <span className="truncate text-sm">
              {getCurrentModelOption().label}
            </span>
          </div>
        </SelectTrigger>
        <SelectContent>
          {isLoading && !isInitialLoad && (
            <SelectGroup>
              <SelectLabel>Loading Models</SelectLabel>
              <SelectItem value="loading" disabled>
                <div className="flex items-center gap-3">
                  <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">
                      Refreshing models...
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      Checking for new models
                    </span>
                  </div>
                </div>
              </SelectItem>
            </SelectGroup>
          )}

          <SelectGroup>
            <SelectLabel>Cloud Models</SelectLabel>
            <SelectItem value="openai">
              <div className="flex items-center gap-3">
                <Bot className="h-4 w-4 flex-shrink-0" />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm">GPT-4o-mini</span>
                  <span className="truncate text-xs text-muted-foreground">
                    Cloud-based AI model
                  </span>
                </div>
              </div>
            </SelectItem>
          </SelectGroup>

          {isOpenRouterConfigured ? (
            <SelectGroup>
              <SelectLabel>OpenRouter Models</SelectLabel>
              {openRouterModels.length === 0 && (
                <SelectItem value="openrouter-loading" disabled>
                  <div className="flex items-center gap-3">
                    <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm">
                        Loading OpenRouter models...
                      </span>
                    </div>
                  </div>
                </SelectItem>
              )}
              {openRouterModels.map((model) => (
                <SelectItem
                  key={`openrouter-${model.id}`}
                  value={`openrouter-${model.id}`}
                >
                  <div className="flex items-center gap-3">
                    <Cloud className="h-4 w-4 flex-shrink-0" />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm">{model.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {model.id}
                      </span>
                    </div>
                  </div>
                </SelectItem>
              ))}
            </SelectGroup>
          ) : (
            <SelectGroup>
              <SelectLabel>OpenRouter</SelectLabel>
              <SelectItem value="openrouter-setup" disabled>
                <div className="flex items-center gap-3">
                  <Cloud className="h-4 w-4 flex-shrink-0" />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">
                      Set OPENROUTER_API_KEY to enable
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      Add the env var and restart the server
                    </span>
                  </div>
                </div>
              </SelectItem>
            </SelectGroup>
          )}

          {ollamaModels.length > 0 && (
            <SelectGroup>
              <SelectLabel>Local Ollama Models</SelectLabel>
              {ollamaModels.map((model) => {
                const option = createModelOption(model);
                const Icon = option.icon;

                return (
                  <SelectItem key={option.id} value={option.id}>
                    <div className="flex items-center gap-3">
                      <Icon className="h-4 w-4 flex-shrink-0" />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm">
                          {option.displayLabel}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      </div>
                    </div>
                  </SelectItem>
                );
              })}
            </SelectGroup>
          )}

          {lmStudioModels.length > 0 && (
            <SelectGroup>
              <SelectLabel>Local LM Studio Models</SelectLabel>
              {lmStudioModels.map((model) => {
                const option = createModelOption(model);
                const Icon = option.icon;

                return (
                  <SelectItem key={option.id} value={option.id}>
                    <div className="flex items-center gap-3">
                      <Icon className="h-4 w-4 flex-shrink-0" />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm">
                          {option.displayLabel}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      </div>
                    </div>
                  </SelectItem>
                );
              })}
            </SelectGroup>
          )}

          {lmStudioModels.length === 0 && (
            <SelectGroup>
              <SelectLabel>LM Studio</SelectLabel>
              <SelectItem value="lmstudio-setup" disabled>
                <div className="flex items-center gap-3">
                  <Monitor className="h-4 w-4 flex-shrink-0" />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">
                      Start LM Studio to use local models
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      Turn on the server and load a model to make it selectable
                    </span>
                  </div>
                </div>
              </SelectItem>
            </SelectGroup>
          )}

          {showDownloadable && downloadableOllamaModels.length > 0 && (
            <SelectGroup>
              <SelectLabel>Downloadable Ollama Models</SelectLabel>
              {downloadableOllamaModels.map((model) => {
                const option = createModelOption(model, true);
                const Icon = option.icon;

                return (
                  <SelectItem key={option.id} value={option.id}>
                    <div className="flex items-center gap-3">
                      <Icon className="h-4 w-4 flex-shrink-0" />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm">
                          {option.displayLabel}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      </div>
                    </div>
                  </SelectItem>
                );
              })}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
