# Presentation Flow & LangChain Usage

How `src/app/api/presentation/` translates a natural-language prompt into a rendered slide deck, and which LangChain pieces are involved at each step.

**Key fact:** the directory is **one-way only** — natural-language prompt → LLM → custom XML DSL → client parser → React components. There is no PPTX→prompt importer (only a theme-color extractor at `src/lib/presentation/pptx-theme-extractor.ts`).

---

## End-to-End Flow

```
┌────────────────────────────────────────────────────────────────────────┐
│  USER (browser)                                                         │
│  topic + metadata (numberOfCards, language, tone, audience, scenario,   │
│                    textContent, webSearch, modelProvider, modelId,      │
│                    imageSource, templateContext...)                     │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ useCompletion (@ai-sdk/react)
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│  STAGE 1 — POST /api/presentation/outline                               │
│    src/app/api/presentation/outline/route.ts                            │
│    LangChain: createAgent (langchain) + optional search_tool (Tavily)   │
│    Output (streamed): <TITLE>...</TITLE> + markdown headings + bullets  │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ user reviews / edits outline in UI
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│  STAGE 2 — POST /api/presentation/generate                              │
│    src/app/api/presentation/generate/route.ts                           │
│    LangChain: PromptTemplate.fromTemplate + RunnableSequence            │
│    Builds SLIDES_TEMPLATE with substitutions for layouts, image query   │
│    style, per-slide template hints, critical rules.                     │
│    Output (streamed): <PRESENTATION><SECTION>...XML DSL...</PRESENTATION>│
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ stream chunks fed to SlideParser
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│  CLIENT — SlideParser.parseChunk → finalize → getAllSlides              │
│    src/components/notebook/presentation/utils/parser.ts                 │
│    Maps each XML tag to a Plate.js TElement (COLUMNS→ColumnPlugin,      │
│    BULLETS→TBulletGroupElement, CHART→Chart elements, etc.)             │
│    Extracts <IMG query="..."> attributes, fires startRootImageGeneration│
│      → getImageFromUnsplash OR generateImageAction (AI)                 │
└────────────────────────────────────────────────────────────────────────┘

  Side flows (also prompt → XML/DSL):
    • POST /api/presentation/generate-slide          (single SECTION)
    • POST /api/presentation/generate-image-slides   (full-bleed image slides)
    • POST /api/presentation/prompt-to-diagram       (NL → AntV Infographic DSL)
    • POST /api/presentation/text-to-diagram         (slide text → AntV DSL)
    • POST /api/presentation/edit-diagram            (existing AntV DSL → edited)

  Discovery routes (no LangChain):
    • GET /api/presentation/local-models       (Ollama + LM Studio)
    • GET /api/presentation/openrouter-models  (OpenRouter catalog)
```

---

## LangChain Primitives Used (where & why)

| Primitive | Imported from | Used in | Purpose |
|---|---|---|---|
| `createAgent` | `langchain` | `outline/route.ts:19,269` | Tool-calling agent so the LLM can optionally call `search_tool` for web research before producing the outline |
| `PromptTemplate.fromTemplate` | `@langchain/core/prompts` | `generate/route.ts:506`, `generate-slide/route.ts:316`, `generate-image-slides/route.ts`, `prompt-to-diagram`, `text-to-diagram`, `edit-diagram` | Compiles a string template with `{PLACEHOLDER}` substitution into a runnable prompt |
| `RunnableSequence.from([prompt, model])` | `@langchain/core/runnables` | All non-outline generation routes | Pipes prompt → ChatModel as a streamable chain |
| `tool(...)` | `langchain` (LangChain tool helper) | `src/ai/tools/search.ts:7-37` | Defines `webSearch` tool (Tavily, max 5 results) consumed by the outline agent |
| `ChatOpenAI` (LangChain chat model) | (via `modelPicker`) `src/lib/model-picker.ts:359-441` | Returned from `modelPicker(provider, modelId)` | Single concrete model class reused for OpenAI / Ollama / LM Studio / OpenRouter by swapping `baseURL` |
| `BaseMessage[]` | `@langchain/core/messages` (via bridge) | Outline route, agent route | Outline route converts incoming AI SDK `UIMessage[]` → LangChain `BaseMessage[]` via `toBaseMessages` |
| `toBaseMessages`, `toUIMessageStream` | `@ai-sdk/langchain` | Every streaming route | Bridges between Vercel AI SDK UI messages and LangChain runnable streams. `toUIMessageStream(stream)` is what makes `createUIMessageStreamResponse({ stream })` work end-to-end |

**Why two patterns** (`createAgent` vs `PromptTemplate + RunnableSequence`):
- The outline stage *might* need tool calls (web search) → agent loop with `tools: [search_tool]`.
- All later stages are pure single-shot generation → simpler `prompt → model` chain is enough.

**Why `ChatOpenAI` for everything**: Ollama, LM Studio, and OpenRouter all expose OpenAI-compatible `/v1` endpoints. `modelPicker` (`src/lib/model-picker.ts`) just changes `baseURL`:
- OpenAI: default
- Ollama: `http://localhost:11434/v1` (with `ensureOllamaModelIsReady` auto-pull)
- LM Studio: `http://localhost:1234/v1` (with `ensureLMStudioModelIsReady`)
- OpenRouter: `https://openrouter.ai/api/v1`

---

## Per-Route Detail

### 1. `outline/route.ts` (prompt → outline markdown)
- Payload: `messages[]` (AI SDK UI messages); per-message metadata holds `numberOfCards`, `language`, `modelProvider`, `modelId`, `webSearch`, `textContent`, `tone`, `audience`, `scenario`, `presentationId`.
- Validates: `assertModelIsConfigured` + `ensureModelIsReady`.
- Builds system prompt via `buildOutlineSystemPrompt` (`outline/route.ts:84`) — string `.replace()` into the constant `outlineSystemPrompt`.
- `createAgent({ model: modelPicker(...), tools: webSearch ? [search_tool] : [], systemPrompt })`.
- Streams with `agent.stream({ messages: await toBaseMessages(messages) }, { streamMode: ["values","messages"] })` then `createUIMessageStreamResponse({ stream: toUIMessageStream(stream) })`.
- Output: `<TITLE>…</TITLE>` then markdown `# Heading` + `- bullets`.

### 2. `generate/route.ts` (outline → full deck XML) — the biggest translator
- Payload: `{ title, prompt, outline[], language, tone, modelId, modelProvider, searchResults, textContent, audience, scenario, imageSource, templateContext, outlineTemplateHints, selectedTemplateCount }`.
- `SLIDES_TEMPLATE` (`generate/route.ts:182`) has slots filled by helpers:
  - `buildAvailableLayouts` (`:331`) — three modes (no templates → `DEFAULT_LAYOUTS` at `:32`; partial; strict template-only).
  - `getImageQueryStyle` (`:301`) — short Unsplash queries vs. 60–120-word AI prompts. Critical detail: image queries must always be in English even if presentation language differs.
  - `buildPerSlideRequirements` (`:382`) — maps `outlineTemplateHints` to per-slide mandates.
  - `buildCriticalRules` (`:413`) — picks rules variant.
  - `formatSearchResults` (`:270`) — folds web research into context.
- Chain: `PromptTemplate.fromTemplate(SLIDES_TEMPLATE) → modelPicker(...)` via `RunnableSequence.from`.
- `chain.stream({...})` → `toUIMessageStream` → `createUIMessageStreamResponse`.
- Output DSL: `<PRESENTATION><SECTION layout="left|right|vertical">{ONE layout component}<IMG query="..."/></SECTION>...</PRESENTATION>`.

### 3. `generate-slide/route.ts` (single slide regeneration)
- Two prompts: `singleSlideTemplate` (standard) and `singleImageSlideTemplate` (full-bleed `isImageSlide="true"`).
- Hardcoded model: `modelPicker("gpt-4o-mini")`.
- Same `PromptTemplate + RunnableSequence` pattern, single `<SECTION>` output.

### 4. `generate-image-slides/route.ts` (image-led decks)
- Output: every slide is `<SECTION isImageSlide="true"><IMG query="..."/></SECTION>` with all text baked into the image prompt.
- Same pattern; supports all four providers.

### 5. `prompt-to-diagram` / `text-to-diagram` / `edit-diagram`
- Translate to/edit AntV Infographic DSL (not the slide XML). Same `PromptTemplate + RunnableSequence` shape.
- `edit-diagram/route.ts:11` pins `INFOGRAPHIC_MODEL = "google/gemini-3-flash-preview"`.
- DSL preservation rules are encoded in the system prompt (e.g., theme block must immediately follow infographic line, before data).

### 6. `local-models/route.ts` & `openrouter-models/route.ts`
- No LangChain. Plain GET endpoints querying Ollama (`/api/tags`), LM Studio (`/api/v1/models`), and OpenRouter (`/v1/models`). Used by the model-picker UI.

---

## How the XML becomes pixels (client side)

- Hook: `useCompletion` from `@ai-sdk/react` (in `SlideGenerationContext.tsx:62` and `PresentationGenerationManager.tsx:476`).
- Streaming buffer is fed each frame (RAF) into `SlideParser.parseChunk()` → `finalize()` → `getAllSlides()` (`src/components/notebook/presentation/utils/parser.ts:207,231,262`).
- Tag → Plate.js element mapping (parser.ts):
  - `COLUMNS`→ColumnPlugin (`:1004`), `BULLETS`→TBulletGroupElement (`:1060`), `ICONS`→TIconListElement (`:1084`), `CYCLE`→TCycleGroupElement (`:1161`), `ARROWS`→TArrowListElement (`:1209`), `PYRAMID`→TPyramidGroupElement (`:1257`), `STAIRCASE`→TStairGroupElement (`:1185`), `BOXES`→TBoxGroupElement (`:1281`), `COMPARE`→TCompareGroupElement (`:1302`), `BEFORE-AFTER`→TBeforeAfterGroupElement (`:1323`), `PROS-CONS`→TProsConsGroupElement (`:1344`), `ARROW-VERTICAL`→TSequenceArrowGroupElement (`:1380`), `TABLE`→TTableElement (`:1426`), `CHART`→Chart variants (`:1589`), `TIMELINE`→TTimelineGroupElement (`:1541`), `STATS`→TStatsGroupElement (`:1401`), `QUOTE`→TQuoteElement (`:1929`).
- `<IMG query="...">` is extracted (`parser.ts:539-580`) and fires `startRootImageGeneration(slideId, query)` (`presentation-state.ts:558-562`); `presentation-image-element.tsx:94-145` then calls either `getImageFromUnsplash(prompt)` (stock) or `generateImageAction(prompt, imageModel)` (AI). The resolved URL is merged back via `mergedSlides` (`PresentationGenerationManager.tsx:165-180`).

---

## Importing PPTX?

There is **no PPT/PPTX → prompt or → outline** code path in the repo. The only PPTX-import code is `src/lib/presentation/pptx-theme-extractor.ts` (`extractThemeFromPptx`), which unzips a `.pptx`, parses `theme*.xml`, and reuses only the **theme colors/fonts**. Slide content is not imported. The reverse direction (export to `.pptx`) is implemented in `domToPptxConverter.ts` (`exportPresentationToPptx`).

---

## Files Worth Opening (reading order)

1. `src/app/api/presentation/outline/route.ts` — entry point, agent + tool.
2. `src/app/api/presentation/generate/route.ts` — main translator, biggest prompt.
3. `src/app/api/presentation/generate-slide/route.ts` — same pattern, smaller scope.
4. `src/lib/model-picker.ts` (`modelPicker`, `assertModelIsConfigured`, `ensureModelIsReady`) — provider bridge.
5. `src/ai/tools/search.ts` — LangChain `tool()` example.
6. `src/lib/ai/uiMessageParts.ts` — UI message helpers.
7. `src/components/notebook/presentation/utils/parser.ts` — XML → Plate.js elements.
8. `src/components/.../PresentationGenerationManager.tsx` — `useCompletion` + parser + image generation.

---

## Verification (how to walk the flow yourself)

- Start the dev server, open the presentation creation UI, and submit a topic with `webSearch=true` to exercise the outline agent + Tavily tool (requires `TAVILY_API_KEY`).
- Watch the Network tab: three streaming requests in order — `/outline`, `/generate`, then per-image POSTs.
- Tail the streamed body for `/generate` to see live XML chunks (`<PRESENTATION>...<SECTION>...`).
- Try a non-OpenAI provider (`Ollama`, `LM Studio`, `OpenRouter`) to confirm `modelPicker` swaps `baseURL` correctly via the `local-models` / `openrouter-models` routes.
- Confirm no PPTX import path: search `rg -i "pptx" src/` — only theme extractor + exporter should appear.
