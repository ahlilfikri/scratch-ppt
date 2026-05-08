# LangChain vs Vercel AI SDK — Decision Memo

**Context:** This project is forked from open source (`allweone/presentation-ai`) and will be customized as a service. This memo records the SWOT comparison between keeping LangChain and dropping it in favor of the Vercel AI SDK alone.

**Scope of the decision:** affects `src/app/api/presentation/*` (6 routes), `src/lib/model-picker.ts`, `src/ai/tools/search.ts`, and the streaming bridge in every route. Client-side code (`useCompletion`, `SlideParser`, Plate.js render path) is unaffected either way.

---

## Option A — Keep LangChain (status quo)

### Strengths
- Zero migration work; ship features today.
- If the roadmap later includes RAG, vector stores, retrievers, document loaders, or LangGraph state machines, LangChain has building blocks ready (with caveats — see Weaknesses).
- LangSmith tracing/evals plug in natively if observability needs grow beyond the current `createLogger` setup.
- Larger surface area of tutorials and recipes online — useful when onboarding contributors.

### Weaknesses
- The codebase only uses ~5% of LangChain. `PromptTemplate.fromTemplate` is effectively `String.replace`; `RunnableSequence.from([prompt, model])` is one `await`. We pay the abstraction tax for nothing.
- Three packages (`langchain`, `@langchain/core`, `@langchain/openai`) + the `@ai-sdk/langchain` bridge add bundle weight, type-inference noise (see `// @ts-expect-error types are incorrectly inferred` in `src/app/api/presentation/generate-slide/route.ts:340`), and a second mental model on top of the AI SDK already used on the client.
- LangChain.js has a churn-y API history (RunnableSequence → LCEL → LangGraph). Each upgrade is a refactor.
- Debugging is harder: stack traces go through Runnable internals before reaching our code.
- Two streaming formats forces a permanent bridge layer (`toBaseMessages`, `toUIMessageStream`) that must be kept in sync with both libraries.

### Opportunities
- LangGraph (separate package) is genuinely strong for multi-step agentic flows if the service grows into agent territory.
- If we build a tools-heavy assistant later (not just slide generation), LangChain's tool/agent ecosystem may pay off.

### Threats
- Maintainer attention on LangChain.js trails the Python version; bug fixes can lag.
- Following upstream `allweone/presentation-ai` is easier if we keep their stack — divergence makes merging their improvements painful.
- A breaking LangChain refactor (it has happened) forces a migration on top of our own roadmap.

---

## Option B — Drop LangChain (Vercel AI SDK only)

### Strengths
- Code becomes ~30–40% shorter per route. `streamText({ model, system, prompt, tools, maxSteps })` + `result.toUIMessageStreamResponse()` replaces the `PromptTemplate` + `RunnableSequence` + bridge stack.
- One mental model end-to-end (`ai` SDK on server, `@ai-sdk/react` on client). Easier onboarding.
- `createOpenAI({ baseURL })` from `@ai-sdk/openai` cleanly handles Ollama / LM Studio / OpenRouter — the same trick `modelPicker` performs today, but native.
- Better TypeScript inference (no `@ts-expect-error` workarounds).
- Smaller bundle, faster cold starts on serverless.
- Native multi-step tool use covers the only non-trivial LangChain feature actually used here (`createAgent` in `outline/route.ts`).

### Weaknesses
- One-time migration: 6 routes + `modelPicker` + the Tavily tool definition. Estimate 1–2 days of work plus retesting each provider (OpenAI, Ollama, LM Studio, OpenRouter).
- We lose the option of plugging in LangChain-only ecosystem packages without re-introducing it later.
- AI SDK doesn't ship retrievers / vector stores / document loaders — those would be composed from standalone libraries (often a plus, sometimes more glue code).
- Slightly less third-party tutorial content than LangChain (still plenty).

### Opportunities
- The Vercel AI SDK is the de-facto standard for Next.js AI apps in 2026. Hiring and AI-coding-tool familiarity is a real win.
- Easier to swap models/providers later — the AI SDK provider interface is cleaner than LangChain's class hierarchy.
- Frees us to adopt MCP, structured-output schemas, and new agent abstractions as the AI SDK adds them (it's moving fast).

### Threats
- The AI SDK has its own breaking changes between major versions (v3 → v4 was non-trivial). Not LangChain-bad, but not zero.
- Still dependent on Vercel's roadmap priorities.
- If the service later needs heavy graph-based agent orchestration, we may end up adding LangGraph anyway, partly negating the simplification.

---

## Recommendation

**Drop LangChain.** Specifically because:

1. The slide-generation use case is **stateless prompt → text streaming**. That is the AI SDK's sweet spot and LangChain's weakest justification.
2. We will be editing every route anyway as we customize. Less indirection = faster iteration.
3. The one feature we'd genuinely miss (`createAgent` web search) maps 1:1 to AI SDK multi-step tool calls.
4. Upstream-merge pain is real but limited — `allweone/presentation-ai` is small, and their churn is mostly in prompts and React components, not the AI plumbing.

### When to reconsider

Re-evaluate this decision if the roadmap adds any of:
- A RAG layer over uploaded documents.
- A multi-agent planner that goes beyond a single tool call.
- LangSmith-based evals as a hard requirement.

Those are the scenarios where keeping LangChain pays for itself.

---

## Migration Mapping (if we proceed with Option B)

| LangChain primitive | Vercel AI SDK replacement |
|---|---|
| `PromptTemplate.fromTemplate(s)` + `.replace()` | Template literals or simple string concat |
| `RunnableSequence.from([prompt, model]).stream(...)` | `streamText({ model, prompt, system })` |
| `createAgent({ model, tools, systemPrompt }).stream(...)` | `streamText({ model, tools, system, maxSteps })` |
| `tool(...)` from `langchain` | `tool(...)` from `ai` |
| `ChatOpenAI` via `modelPicker` | `createOpenAI({ baseURL })(modelId)` |
| `toBaseMessages` + `toUIMessageStream` + `createUIMessageStreamResponse` | `result.toUIMessageStreamResponse()` |

### Files affected

- `src/app/api/presentation/outline/route.ts` (agent + Tavily tool)
- `src/app/api/presentation/generate/route.ts` (largest prompt template)
- `src/app/api/presentation/generate-slide/route.ts`
- `src/app/api/presentation/generate-image-slides/route.ts`
- `src/app/api/presentation/prompt-to-diagram/route.ts`
- `src/app/api/presentation/text-to-diagram/route.ts`
- `src/app/api/presentation/edit-diagram/route.ts`
- `src/lib/model-picker.ts` (provider bridge)
- `src/ai/tools/search.ts` (LangChain `tool()` → AI SDK `tool()`)

### Packages to remove

- `langchain`
- `@langchain/core`
- `@langchain/openai`
- `@ai-sdk/langchain`

### Packages to ensure (likely already present via `@ai-sdk/react`)

- `ai`
- `@ai-sdk/openai`

### Suggested migration order

1. Smallest route first: `generate-slide/route.ts` — proof of concept, compare diff size.
2. Diagram routes (`prompt-to-diagram`, `text-to-diagram`, `edit-diagram`) — same shape, low risk.
3. `generate-image-slides/route.ts`.
4. `generate/route.ts` — biggest prompt, most placeholders.
5. `outline/route.ts` — last because the agent + tool conversion is the most novel piece.
6. Replace `modelPicker.ts` with a thin `createOpenAI({ baseURL })` factory.
7. Remove LangChain packages, run typecheck, retest each provider end-to-end.
