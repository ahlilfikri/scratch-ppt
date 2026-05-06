# Migration Guide — Split presentation-ai into Next.js (frontend) + Express (backend service)

## Context

`presentation-ai` is currently one Next.js 16 / React 19 app that owns UI + AI generation (LangChain + LangGraph + OpenAI/Together/FAL/Tavily/Gemini) + Postgres persistence (Prisma) + NextAuth + UploadThing.

Goal: extract the backend so AI generation + persistence become **a reusable service any project can call over HTTP**, while the Next.js app becomes a pure UI client.

**Yes, this split is feasible.** The codebase is already shaped for it — every "backend-y" thing lives in `src/app/api/*`, `src/app/_actions/*`, `src/ai/*`, `src/server/*`, and `src/lib/modelPicker.ts`. UI ↔ backend seams are well defined: REST routes + server actions + AI-SDK `useChat`.

Decisions captured up front:
- **Service scope:** AI generation + persistence (Express owns AI *and* DB CRUD).
- **Auth:** JWT (reuse NextAuth). Next.js issues JWTs; Express verifies them with the shared `NEXTAUTH_SECRET`.
- **DB ownership:** Express only. Next.js never imports `@prisma/client`.

---

## Table of contents

1. Repo & deployment shape
2. Models — auth, data, contracts
3. The JWT auth flow (in detail)
4. Streaming over HTTP in Express (the most important technical detail)
5. Per-process flows (every flow, every service)
   - 5.1 Sign in / session
   - 5.2 Outline generation (SSE)
   - 5.3 Full presentation generation (SSE)
   - 5.4 Single slide regeneration (SSE)
   - 5.5 Image-slides generation (admin, SSE)
   - 5.6 Diagram generation: text-to-diagram, edit, prompt-to-diagram (SSE)
   - 5.7 Agent chat with tools (LangGraph, SSE, stateful)
   - 5.8 Web search tool
   - 5.9 Local & OpenRouter model discovery
   - 5.10 Presentation CRUD + auto-save
   - 5.11 Public share (no auth)
   - 5.12 Theme CRUD + favorite + like
   - 5.13 Font pair CRUD
   - 5.14 Image generation (FAL / Together / Unsplash / Pixabay / Giphy)
   - 5.15 File upload (UploadThing stays in Next.js)
6. File-by-file mapping (old → new)
7. JWT middleware code (full)
8. Frontend `api.ts` wrapper code
9. Express bootstrap code
10. Phased migration plan with exact commands
11. Environment variables — who needs what
12. Verification checklist
13. Out of scope (future work)

---

## 1. Repo & deployment shape

Convert single repo to a pnpm workspace monorepo:

```
presentation-ai/
├── pnpm-workspace.yaml
├── package.json                          # root (private, workspaces)
├── apps/
│   ├── web/                              # Next.js 16 — UI only — port 3000
│   │   ├── package.json
│   │   ├── next.config.js
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── app/
│   │       │   ├── (pages)/...           # all current pages
│   │       │   ├── api/
│   │       │   │   ├── auth/[...nextauth]/route.ts   # NextAuth — STAYS
│   │       │   │   └── uploadthing/                  # UploadThing — STAYS
│   │       │   └── share/                # public share page
│   │       ├── components/               # all UI (unchanged)
│   │       ├── states/                   # Zustand (unchanged)
│   │       ├── hooks/                    # frontend hooks
│   │       ├── lib/
│   │       │   ├── api.ts                # NEW: typed fetch wrapper to Express
│   │       │   └── auth-helpers.ts       # NEW: getJwtForCurrentSession()
│   │       └── env.js                    # client + NextAuth env only
│   └── api/                              # Express service — port 3001
│       ├── package.json
│       ├── tsconfig.json
│       ├── prisma/
│       │   ├── schema.prisma             # MOVED here
│       │   └── migrations/
│       └── src/
│           ├── index.ts                  # express bootstrap
│           ├── routes/
│           │   ├── generate.ts
│           │   ├── agent.ts
│           │   ├── diagrams.ts
│           │   ├── models.ts
│           │   ├── presentations.ts
│           │   ├── themes.ts
│           │   ├── font-pairs.ts
│           │   └── images.ts
│           ├── middleware/
│           │   ├── jwt.ts
│           │   ├── error.ts
│           │   └── logger.ts
│           ├── ai/                       # MOVED from src/ai/
│           ├── lib/
│           │   ├── modelPicker.ts        # MOVED
│           │   └── observability/        # MOVED
│           └── server/
│               ├── auth.ts               # NEW: JWT verify only
│               ├── db.ts                 # MOVED Prisma client
│               └── share/
│                   └── authorization.ts  # MOVED
└── packages/
    └── shared/                           # types + zod schemas shared by both apps
        ├── package.json
        └── src/
            ├── index.ts
            ├── dtos/                     # PresentationDTO, ThemeDTO, ...
            └── schemas/                  # zod schemas for every request body
```

**Local dev:** `pnpm -F web dev` and `pnpm -F api dev` in two terminals (or `pnpm dev` at the root using `concurrently`).

**Deployment:** two separate processes. Frontend env: `NEXT_PUBLIC_API_URL=https://api.example.com`. CORS allowlist on Express points at the web origin.

---

## 2. Models — auth, data, contracts

### 2.1 Auth model (JWT-shared-secret)

NextAuth in `apps/web` already uses a JWT session strategy. Keep it. The flow is:

1. NextAuth signs the session JWT with `NEXTAUTH_SECRET` and stores it in an HTTP-only cookie.
2. On every Express call, the frontend reads the JWT (server-side via `next-auth/jwt` `getToken`, or by hitting a small `/api/auth/jwt` endpoint from the client) and attaches `Authorization: Bearer <jwt>`.
3. `apps/api` middleware verifies the JWT against the same `NEXTAUTH_SECRET` and attaches `req.user = { id, role, hasAccess, isAdmin }`.
4. **Only coupling between the two apps at runtime is the shared secret.**
5. Public endpoints (e.g. `GET /v1/presentations/:id/shared`) skip the middleware via a route-level allowlist.

> External (non-Next.js) consumers can either: (a) implement NextAuth flow and obtain a JWT, or (b) use a future `/auth/exchange` endpoint that swaps a service API key for a short-lived JWT. The verifier won't change.

### 2.2 Data model (Prisma)

Move `prisma/` whole into `apps/api/prisma/`. **Schema unchanged.** Models: `User`, `BaseDocument`, `Presentation`, `PresentationTheme`, `FavoritePresentationTheme`, `PresentationThemeLike`, `FontPair`, `FavoriteDocument`, `GeneratedImage`, `Account`. Prisma client is instantiated only in `apps/api/src/server/db.ts`.

`canEditDocument` / `canReadDocument` (currently `src/server/share/authorization.ts`) move to `apps/api/src/server/share/` and are called inside route handlers, not middleware.

### 2.3 API contract (REST + SSE)

All paths prefixed `/v1`. Auth required unless marked **public**.

| Method | Path | Replaces |
|---|---|---|
| **AI generation (all SSE streams)** | | |
| POST | `/v1/agent/presentation` | `src/app/api/agent/presentation/route.ts` |
| POST | `/v1/agent/presentation/search` | `src/app/api/agent/presentation/search/route.ts` |
| POST | `/v1/generate/outline` | `src/app/api/presentation/outline/route.ts` |
| POST | `/v1/generate/presentation` | `src/app/api/presentation/generate/route.ts` |
| POST | `/v1/generate/slide` | `src/app/api/presentation/generate-slide/route.ts` |
| POST | `/v1/generate/image-slides` | `generate-image-slides/route.ts` (admin) |
| POST | `/v1/diagrams/text-to-diagram` | `text-to-diagram/route.ts` |
| POST | `/v1/diagrams/edit` | `edit-diagram/route.ts` |
| POST | `/v1/diagrams/prompt-to-diagram` | `prompt-to-diagram/route.ts` |
| GET | `/v1/models/local` | `local-models/route.ts` |
| GET | `/v1/models/openrouter` | `openrouter-models/route.ts` |
| **Persistence (replaces server actions)** | | |
| GET / POST | `/v1/presentations` | `_actions/notebook/presentation/*` |
| GET / PATCH / DELETE | `/v1/presentations/:id` | same |
| GET **public** | `/v1/presentations/:id/shared` | `sharedPresentationActions.ts` |
| PATCH | `/v1/presentations/:id/thumbnail` | `presentation-thumbnail-actions.ts` |
| GET / DELETE | `/v1/presentations/:id/messages` | `getPresentationMessages.ts`, `clearPresentationChat.ts` |
| GET / POST | `/v1/themes` | `theme-actions.ts` |
| POST / DELETE | `/v1/themes/:id/favorite` | `theme-favorite-actions.ts` |
| POST / DELETE | `/v1/themes/:id/like` | `theme-like-actions.ts` |
| GET / POST | `/v1/font-pairs` | `font-pair-actions.ts` |
| POST | `/v1/images/generate` | `_actions/image/generate.ts`, `presentation/generate-slide-image.ts` |
| GET | `/v1/images/unsplash` | `_actions/image/unsplash.ts`, `apps/image-studio/unsplash.ts` |
| GET | `/v1/images/pixabay` | `apps/image-studio/pixabay.ts` |
| GET | `/v1/images/giphy` | `apps/image-studio/giphy.ts` |

`/api/auth/*` and `/api/uploadthing/*` **stay in Next.js**. UploadThing only handles upload-to-CDN; persisting the resulting URL hits Express.

DTO types and zod schemas live in `packages/shared`. Express validates with `schema.parse(req.body)`; frontend imports the same types for static typing.

---

## 3. The JWT auth flow (in detail)

```
Browser                           apps/web (Next.js)              apps/api (Express)
   │                                    │                                 │
   │ 1. /auth/signin (Google OAuth)    │                                 │
   ├───────────────────────────────────▶│                                 │
   │                                    │ NextAuth handles OAuth          │
   │                                    │ Issues JWT signed with          │
   │                                    │ NEXTAUTH_SECRET, stored in      │
   │                                    │ HTTP-only `next-auth.session-   │
   │                                    │ token` cookie.                  │
   │ 2. set-cookie + redirect          │                                 │
   │◀───────────────────────────────────┤                                 │
   │                                    │                                 │
   │ 3. User opens dashboard           │                                 │
   ├───────────────────────────────────▶│                                 │
   │                                    │ Server component reads JWT      │
   │                                    │ via `getToken({ req })` and     │
   │                                    │ passes it to client via prop    │
   │                                    │ OR client calls /api/auth/jwt   │
   │                                    │ to fetch the raw token.         │
   │                                    │                                 │
   │ 4. fetch /v1/presentations        │                                 │
   │    Authorization: Bearer <jwt>    │                                 │
   ├────────────────────────────────────┴────────────────────────────────▶│
   │                                                                      │
   │                                                                      │ 5. jwtMiddleware verifies
   │                                                                      │    signature with NEXTAUTH_SECRET
   │                                                                      │    Attaches req.user
   │                                                                      │
   │                                                                      │ 6. handler queries Prisma
   │                                                                      │    using req.user.id
   │                                                                      │
   │ 7. JSON response                                                     │
   │◀─────────────────────────────────────────────────────────────────────┤
```

NextAuth uses `next-auth.session-token` with HS256 by default for JWT strategy. Express verifies the same algorithm.

For **streaming** endpoints (every `/v1/generate/*`, `/v1/agent/*`, `/v1/diagrams/*`), the `useChat` hook from `@ai-sdk/react` accepts `headers: { Authorization: \`Bearer ${jwt}\` }`. Same flow — auth header on every call.

---

## 4. Streaming over HTTP in Express (the most important technical detail)

Most existing routes use:

```ts
return createUIMessageStreamResponse({
  stream: toUIMessageStream(chain.stream(input)),
});
```

This returns a Web `Response` whose body is a `ReadableStream`. Next.js handles it natively. **Express does not.** Two options:

**Option A — `@ai-sdk/express` adapter (recommended).** Use `pipeUIMessageStreamToResponse(res, stream)`. The package mirrors what Next.js does for `Response`. Add it to `apps/api/package.json`.

**Option B — manual.** Set headers and write chunks:

```ts
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache, no-transform');
res.setHeader('X-Accel-Buffering', 'no');               // disable nginx buffering
res.flushHeaders();

const reader = stream.getReader();
const decoder = new TextDecoder();
try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(decoder.decode(value));
  }
} finally {
  res.end();
}
```

Either way, the **client** code is unchanged: `useChat({ api: '...', headers: {...} })` from `@ai-sdk/react` consumes both Next.js and Express streams identically because they speak the same SSE protocol.

**Reverse proxy gotcha:** if you put nginx / Cloudflare in front, you must disable response buffering for these routes (`proxy_buffering off;` in nginx, `disable buffering` rule in Cloudflare). Otherwise the client won't see chunks until the stream completes — defeating the point.

---

## 5. Per-process flows

For every process below: client trigger → request shape → Express handler responsibilities → response shape → client side-effects.

### 5.1 Sign in / session

- **Trigger:** user clicks "Sign in with Google".
- **Flow:** entirely inside `apps/web`, handled by NextAuth. Express not involved.
- **Outcome:** NextAuth cookie containing the JWT. Subsequent Express calls attach this JWT.

### 5.2 Outline generation (SSE)

- **Trigger:** user clicks "Generate Outline" in `PresentationGenerationManager`.
- **Endpoint:** `POST /v1/generate/outline`
- **Headers:** `Authorization: Bearer <jwt>`
- **Request body:**
  ```ts
  {
    prompt: string;
    numberOfCards: number;
    language: string;
    pastedContent?: string;
    webSearch?: boolean;
    modelId?: string;
    modelProvider?: 'openai' | 'ollama' | 'lmstudio' | 'openrouter';
  }
  ```
- **Express responsibilities:**
  1. `jwtMiddleware` → `req.user`
  2. `assertModelIsConfigured(modelProvider, modelId)`
  3. Build LangChain `RunnableSequence` with `PromptTemplate` (port from `outline/route.ts`)
  4. If `webSearch`, call Tavily and inject results into the prompt
  5. Stream model output as SSE
- **Response:** SSE stream of markdown outline chunks (as currently).
- **Client effect:** `useChat` accumulates chunks → Zustand `presentation-state.outline` updates live → on completion, frontend POSTs `PATCH /v1/presentations/:id` with the finalized outline.

### 5.3 Full presentation generation (SSE)

- **Trigger:** user clicks "Generate Presentation".
- **Endpoint:** `POST /v1/generate/presentation`
- **Request body:**
  ```ts
  {
    title: string;
    prompt: string;
    outline: string[];
    language: string;
    tone: string;
    modelId?: string;
    modelProvider?: 'openai' | 'ollama' | 'lmstudio' | 'openrouter';
    searchResults?: { query: string; results: unknown[] }[];
    textContent?: 'minimal' | 'concise' | 'detailed' | 'extensive';
    audience?: string;
    scenario?: string;
    imageSource?: 'automatic' | 'ai' | 'stock';
    templateContext?: string;
    outlineTemplateHints?: Record<number, string>;
    selectedTemplateCount?: number;
  }
  ```
- **Express responsibilities:**
  1. `jwtMiddleware`
  2. Build LangChain chain with `DEFAULT_LAYOUTS` prompt prefix (port from `generate/route.ts`)
  3. Stream XML chunks
- **Response:** SSE stream of XML chunks describing slides.
- **Client effect:** XML is parsed on the fly into slides and pushed into `presentation-state`. Each completed slide triggers `PATCH /v1/presentations/:id`. `<IMG>` placeholders trigger `POST /v1/images/generate` in parallel.

### 5.4 Single slide regeneration (SSE)

- **Trigger:** user clicks "Regenerate this slide" in the editor.
- **Endpoint:** `POST /v1/generate/slide`
- **Request body:** `{ slideIndex, slideContext, presentationContext, ... }` — port from `generate-slide/route.ts`.
- **Response:** SSE stream of one slide's XML.
- **Client effect:** replace that slide in Zustand, persist with `PATCH /v1/presentations/:id`.

### 5.5 Image-slides generation (admin, SSE)

- **Trigger:** admin-only "Generate full-bleed image slides" feature.
- **Endpoint:** `POST /v1/generate/image-slides`
- **Express responsibilities:**
  1. `jwtMiddleware`
  2. **403 if `req.user.isAdmin !== true`**
  3. Stream XML
- **Response:** SSE stream.

### 5.6 Diagram generation (3 endpoints, SSE)

All three use Google Gemini 3 Flash + AntV `@antv/infographic` syntax.

| Endpoint | Body | Purpose |
|---|---|---|
| `POST /v1/diagrams/text-to-diagram` | `{ text, hint? }` | Generate diagram DSL from arbitrary text |
| `POST /v1/diagrams/edit` | `{ currentSyntax, instruction }` | Modify existing AntV syntax |
| `POST /v1/diagrams/prompt-to-diagram` | `{ prompt }` | Generate diagram DSL from a short prompt |

- **Response:** SSE stream of AntV DSL chunks.
- **Client effect:** `infographic-streaming-state` accumulates the DSL; `@antv/infographic` renders it. On completion, persist as part of the slide's content via `PATCH /v1/presentations/:id`.

### 5.7 Agent chat with tools (LangGraph, SSE, stateful)

This is the most complex flow.

- **Trigger:** user opens `PresentationAgentPanel` and sends a message.
- **Endpoint:** `POST /v1/agent/presentation`
- **Request body:**
  ```ts
  {
    messages: UIMessage[];          // ai-sdk message history
    presentationId: string;         // for thread persistence
    presentationContext: {          // current slide JSON, theme, etc.
      slides: Slide[];
      theme: string;
      ...
    };
    modelId?: string;
    modelProvider?: 'openai' | 'ollama' | 'lmstudio' | 'openrouter';
    webSearch?: boolean;
  }
  ```
- **Express responsibilities:**
  1. `jwtMiddleware`
  2. Verify `canEditDocument(req.user.id, presentationId)`
  3. Build LangGraph agent via `createAgent({ modelId, modelProvider, webSearch, presentationContext })` (ported from `src/ai/agents/presentation/createAgent.ts`)
  4. Use `PostgresSaver` checkpointer keyed on `thread_id = presentationId` so conversations resume. Same Postgres, separate tables (`@langchain/langgraph-checkpoint-postgres` creates them automatically).
  5. Stream agent state via `toUIMessageStream(...)` → `pipeUIMessageStreamToResponse(res, ...)`
- **Tools (run server-side inside the agent):**
  - `search_tool` → Tavily web search
  - `edit_slide_properties` → returns a structured tool message; the **client** applies the edit to Zustand
  - `replace_image` → if `imagePrompt` given, calls FAL/Together to generate; if `imageUrl` given, uses it directly
- **Response:** SSE stream of agent messages + tool calls + tool results.
- **Client effect:** `PresentationAgentPanel` renders messages; tool result messages with `edit_slide_properties` mutate Zustand; `replace_image` results swap the slide image and persist via `PATCH /v1/presentations/:id`.

### 5.8 Web search tool (one-off)

- **Endpoint:** `POST /v1/agent/presentation/search`
- **Body:** `{ query: string }`
- **Response:** JSON. `{ results: TavilyResult[] }`
- Used when the agent UI wants to preview search hits before sending the user's message.

### 5.9 Local & OpenRouter model discovery

- `GET /v1/models/local` → JSON list. Calls `localhost:11434/api/tags` (Ollama) and `localhost:1234/v1/models` (LM Studio) **on the Express host**. Returns merged list. ⚠ This means the user's local Ollama runs on the Express host, not on their browser machine. If you want browser-local models, this endpoint must stay in Next.js *or* the client must call Ollama directly. **Decision needed at implementation time** — see Section 13.
- `GET /v1/models/openrouter` → JSON list, fetched from OpenRouter API.

### 5.10 Presentation CRUD + auto-save

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/v1/presentations?cursor=&limit=` | — | `{ items: PresentationDTO[]; nextCursor? }` |
| POST | `/v1/presentations` | `{ title, prompt? }` | `PresentationDTO` |
| GET | `/v1/presentations/:id` | — | `PresentationDTO` |
| PATCH | `/v1/presentations/:id` | partial `PresentationDTO` | `PresentationDTO` |
| DELETE | `/v1/presentations/:id` | — | `{ ok: true }` |

Auto-save flow:
1. Editor change → Zustand updates locally (instant UI).
2. `useDebouncedSave` waits 800 ms.
3. Calls `api.presentations.update(id, partial)` → `PATCH /v1/presentations/:id`.
4. Express verifies `canEditDocument`, applies the partial update via Prisma, returns the updated row.

### 5.11 Public share (no auth)

- **Endpoint:** `GET /v1/presentations/:id/shared`
- **Auth:** none — middleware allowlisted.
- **Express responsibilities:** read presentation only if `isPublic = true`. If not, 404 (not 401, to avoid leaking existence).
- **Client effect:** `app/share/presentation/[id]/page.tsx` (Server Component) calls this from the Next.js server, renders read-only view.

### 5.12 Theme CRUD + favorite + like

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/v1/themes?scope=mine\|public\|favorites` | — | `ThemeDTO[]` |
| POST | `/v1/themes` | `{ name, description?, themeData, logoUrl?, isPublic? }` | `ThemeDTO` |
| POST | `/v1/themes/:id/favorite` | — | `{ ok: true }` |
| DELETE | `/v1/themes/:id/favorite` | — | `{ ok: true }` |
| POST | `/v1/themes/:id/like` | — | `{ likeCount: number }` |
| DELETE | `/v1/themes/:id/like` | — | `{ likeCount: number }` |

### 5.13 Font pair CRUD

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/v1/font-pairs` | — | `FontPairDTO[]` |
| POST | `/v1/font-pairs` | `{ heading, headingUrl?, headingWeight, body, bodyUrl?, bodyWeight }` | `FontPairDTO` |

### 5.14 Image generation

| Endpoint | Body | Behavior |
|---|---|---|
| `POST /v1/images/generate` | `{ prompt, model: 'fal'\|'together', size? }` | Calls FAL or Together; saves a `GeneratedImage` row; returns `{ url }`. |
| `GET /v1/images/unsplash?q=&page=` | — | Proxies Unsplash search. |
| `GET /v1/images/pixabay?q=&page=` | — | Proxies Pixabay. |
| `GET /v1/images/giphy?q=&page=` | — | Proxies Giphy. |

All image-provider API keys live in `apps/api` only; the browser never sees them.

### 5.15 File upload (UploadThing — stays in Next.js)

1. User picks file → `<UploadButton>` POSTs to `/api/uploadthing` on Next.js (NextAuth `auth()` verifies session — already works, unchanged).
2. UploadThing returns the CDN URL to the client.
3. Client posts the URL to e.g. `POST /v1/font-pairs` on Express. Express persists. Done.

UploadThing has its own metadata in its hosted service; we only persist the URL string.

---

## 6. File-by-file mapping (old → new)

### Move whole directories

| From | To |
|---|---|
| `prisma/` | `apps/api/prisma/` |
| `src/ai/` | `apps/api/src/ai/` |
| `src/lib/modelPicker.ts` | `apps/api/src/lib/modelPicker.ts` |
| `src/lib/observability/` | `apps/api/src/lib/observability/` |
| `src/server/db.ts` | `apps/api/src/server/db.ts` |
| `src/server/share/authorization.ts` | `apps/api/src/server/share/authorization.ts` |

### Split

`src/server/auth.ts` (currently has both NextAuth config and `auth()` helper):
- NextAuth config (`authOptions`, providers, callbacks) → `apps/web/src/server/auth.ts`.
- New file `apps/api/src/server/auth.ts` with only `verifyJwt(token)` using `jose` + `NEXTAUTH_SECRET`.

### Convert and move

Each of these becomes a route handler in `apps/api/src/routes/`:

| From | To |
|---|---|
| `src/app/api/agent/presentation/route.ts` | `routes/agent.ts` POST `/presentation` |
| `src/app/api/agent/presentation/search/route.ts` | `routes/agent.ts` POST `/presentation/search` |
| `src/app/api/presentation/outline/route.ts` | `routes/generate.ts` POST `/outline` |
| `src/app/api/presentation/generate/route.ts` | `routes/generate.ts` POST `/presentation` |
| `src/app/api/presentation/generate-slide/route.ts` | `routes/generate.ts` POST `/slide` |
| `src/app/api/presentation/generate-image-slides/route.ts` | `routes/generate.ts` POST `/image-slides` |
| `src/app/api/presentation/text-to-diagram/route.ts` | `routes/diagrams.ts` POST `/text-to-diagram` |
| `src/app/api/presentation/edit-diagram/route.ts` | `routes/diagrams.ts` POST `/edit` |
| `src/app/api/presentation/prompt-to-diagram/route.ts` | `routes/diagrams.ts` POST `/prompt-to-diagram` |
| `src/app/api/presentation/local-models/route.ts` | `routes/models.ts` GET `/local` |
| `src/app/api/presentation/openrouter-models/route.ts` | `routes/models.ts` GET `/openrouter` |
| `src/app/_actions/notebook/presentation/*` | `routes/presentations.ts` |
| `src/app/_actions/presentation/sharedPresentationActions.ts` | `routes/presentations.ts` GET `/:id/shared` |
| `src/app/_actions/presentation/presentation-thumbnail-actions.ts` | `routes/presentations.ts` PATCH `/:id/thumbnail` |
| `src/app/_actions/presentation/getPresentationMessages.ts` | `routes/presentations.ts` GET `/:id/messages` |
| `src/app/_actions/presentation/clearPresentationChat.ts` | `routes/presentations.ts` DELETE `/:id/messages` |
| `src/app/_actions/presentation/theme-actions.ts` | `routes/themes.ts` |
| `src/app/_actions/presentation/theme-favorite-actions.ts` | `routes/themes.ts` |
| `src/app/_actions/presentation/theme-like-actions.ts` | `routes/themes.ts` |
| `src/app/_actions/presentation/font-pair-actions.ts` | `routes/font-pairs.ts` |
| `src/app/_actions/presentation/generate-slide-image.ts` | `routes/images.ts` POST `/generate` |
| `src/app/_actions/image/generate.ts` | `routes/images.ts` POST `/generate` (merge) |
| `src/app/_actions/image/unsplash.ts` | `routes/images.ts` GET `/unsplash` |
| `src/app/_actions/apps/image-studio/*.ts` | `routes/images.ts` |

### Stays in Next.js

- `src/app/api/auth/[...nextauth]/route.ts`
- `src/app/api/uploadthing/route.ts`, `core.ts`
- `src/proxy.ts` (NextAuth-aware redirects)
- All pages, components, states, hooks, styles, plate/prosemirror editors

### Delete from Next.js (after migration)

- `src/app/api/agent/`, `src/app/api/presentation/`
- `src/app/_actions/`
- `src/server/db.ts`, `src/server/share/`
- `src/ai/`, `src/lib/modelPicker.ts`, `src/lib/observability/`
- `prisma/`
- Remove `@prisma/client`, `prisma`, `langchain`, `@langchain/*`, `@ai-sdk/langchain`, `@tavily/core`, `@fal-ai/client`, `together-ai`, `pg` from `apps/web/package.json`.

---

## 7. JWT middleware code (full)

`apps/api/src/middleware/jwt.ts`:

```ts
import type { NextFunction, Request, Response } from 'express';
import { decode } from 'next-auth/jwt';

export interface AuthedRequest extends Request {
  user?: {
    id: string;
    role: 'ADMIN' | 'USER';
    hasAccess: boolean;
    isAdmin: boolean;
  };
}

const PUBLIC_PATHS = [
  /^\/v1\/presentations\/[^/]+\/shared$/,
  /^\/health$/,
];

export async function jwtMiddleware(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) {
  if (PUBLIC_PATHS.some((re) => re.test(req.path))) return next();

  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_authorization' });
  }
  const token = header.slice(7);

  try {
    const decoded = await decode({
      token,
      secret: process.env.NEXTAUTH_SECRET!,
      // salt: must match NextAuth's cookie name; for the default JWT strategy
      // `next-auth.session-token` is the salt. Match what NextAuth uses.
      salt: 'next-auth.session-token',
    });
    if (!decoded?.sub) {
      return res.status(401).json({ error: 'invalid_token' });
    }
    req.user = {
      id: decoded.sub,
      role: (decoded.role as 'ADMIN' | 'USER') ?? 'USER',
      hasAccess: Boolean(decoded.hasAccess),
      isAdmin: Boolean(decoded.isAdmin),
    };
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'admin_only' });
  return next();
}
```

> Verify NextAuth's actual salt/cookie convention against the running app — this varies between NextAuth v4 and v5. Adjust `salt` to match.

---

## 8. Frontend `api.ts` wrapper code

`apps/web/src/lib/api.ts`:

```ts
import { getJwtForCurrentSession } from './auth-helpers';

const BASE = process.env.NEXT_PUBLIC_API_URL!;

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const jwt = await getJwtForCurrentSession();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  presentations: {
    list: (cursor?: string) =>
      jsonFetch<{ items: PresentationDTO[]; nextCursor?: string }>(
        `/v1/presentations${cursor ? `?cursor=${cursor}` : ''}`,
      ),
    get: (id: string) => jsonFetch<PresentationDTO>(`/v1/presentations/${id}`),
    create: (body: CreatePresentationBody) =>
      jsonFetch<PresentationDTO>('/v1/presentations', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (id: string, body: Partial<PresentationDTO>) =>
      jsonFetch<PresentationDTO>(`/v1/presentations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    delete: (id: string) =>
      jsonFetch<{ ok: true }>(`/v1/presentations/${id}`, { method: 'DELETE' }),
    shared: (id: string) =>
      jsonFetch<PresentationDTO>(`/v1/presentations/${id}/shared`),
  },
  themes: { /* ... */ },
  fontPairs: { /* ... */ },
  images: { /* ... */ },
};

export const sseUrl = (path: string) => `${BASE}${path}`;
// useChat({ api: sseUrl('/v1/generate/outline'), headers: { Authorization: `Bearer ${jwt}` } })
```

`apps/web/src/lib/auth-helpers.ts`:

```ts
'use server';
import { getToken } from 'next-auth/jwt';
import { headers } from 'next/headers';

export async function getJwtForCurrentSession(): Promise<string | null> {
  const h = await headers();
  // Reconstruct a minimal req-like object for getToken
  const cookie = h.get('cookie') ?? '';
  // ... or call NextAuth's session endpoint internally and extract the raw token
  // For client components, expose this via a route handler /api/auth/jwt that
  // reads the cookie server-side and returns { token } so the client can
  // attach it to Express calls.
  return null; // sketch — real impl depends on NextAuth version
}
```

For client components, the simplest pattern is a tiny Next.js route `/api/auth/jwt/route.ts` that runs `getToken({ req })` server-side and returns `{ token }`. The client fetches it once on mount (and refreshes on session change).

---

## 9. Express bootstrap code

`apps/api/src/index.ts`:

```ts
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { jwtMiddleware } from './middleware/jwt.js';
import { errorHandler } from './middleware/error.js';
import { logger } from './middleware/logger.js';
import generateRouter from './routes/generate.js';
import agentRouter from './routes/agent.js';
import diagramsRouter from './routes/diagrams.js';
import modelsRouter from './routes/models.js';
import presentationsRouter from './routes/presentations.js';
import themesRouter from './routes/themes.js';
import fontPairsRouter from './routes/font-pairs.js';
import imagesRouter from './routes/images.js';

const app = express();

app.use(cors({ origin: process.env.WEB_ORIGIN!, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(logger);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/v1', jwtMiddleware);              // applied after public allowlist inside middleware
app.use('/v1/generate', generateRouter);
app.use('/v1/agent', agentRouter);
app.use('/v1/diagrams', diagramsRouter);
app.use('/v1/models', modelsRouter);
app.use('/v1/presentations', presentationsRouter);
app.use('/v1/themes', themesRouter);
app.use('/v1/font-pairs', fontPairsRouter);
app.use('/v1/images', imagesRouter);

app.use(errorHandler);

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => console.log(`api listening on :${port}`));
```

A single route handler example — `apps/api/src/routes/generate.ts` (outline):

```ts
import { Router } from 'express';
import { pipeUIMessageStreamToResponse } from '@ai-sdk/express';
import { toUIMessageStream } from '@ai-sdk/langchain';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { modelPicker } from '../lib/modelPicker.js';
import { OutlineSchema } from '@presentation/shared';
import type { AuthedRequest } from '../middleware/jwt.js';

const router = Router();

router.post('/outline', async (req: AuthedRequest, res, next) => {
  try {
    const body = OutlineSchema.parse(req.body);
    const model = await modelPicker(body.modelProvider, body.modelId);
    const prompt = PromptTemplate.fromTemplate(/* ... existing template ... */);
    const chain = RunnableSequence.from([prompt, model]);
    const stream = await chain.stream({ /* ... */ });
    pipeUIMessageStreamToResponse(res, toUIMessageStream(stream));
  } catch (e) { next(e); }
});

export default router;
```

---

## 10. Phased migration plan with exact commands

**Phase A — Workspace skeleton (no behavior change yet)**

```bash
# At repo root
mkdir -p apps/web apps/api/src packages/shared/src
# Move current Next.js into apps/web — preserve git history with git mv
git mv src apps/web/src
git mv prisma apps/api/prisma
git mv next.config.js apps/web/
git mv next-env.d.ts apps/web/
git mv tailwind.config.ts apps/web/
git mv postcss.config.mjs apps/web/
git mv components.json apps/web/
git mv tsconfig.json apps/web/
git mv biome.json .                       # biome can stay at root
git mv package.json apps/web/
# Create new root package.json with workspaces, pnpm-workspace.yaml
# Create apps/api/package.json
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

Root `package.json`:
```json
{
  "name": "presentation-ai-monorepo",
  "private": true,
  "scripts": {
    "dev": "pnpm -F web dev & pnpm -F api dev",
    "build": "pnpm -r build",
    "type": "pnpm -r type"
  }
}
```

`apps/api/package.json` deps: `express`, `cors`, `zod`, `next-auth` (for `decode`), `@ai-sdk/express`, `@ai-sdk/langchain`, `@langchain/core`, `@langchain/openai`, `@langchain/langgraph`, `@langchain/langgraph-checkpoint-postgres`, `@prisma/client`, `prisma`, `tsx`, `typescript`, `pg`, `@tavily/core`, `@fal-ai/client`, `together-ai`, `pino`, `pino-http`, plus all model SDKs the existing code uses.

**Phase B — Move the AI core**

Move these into `apps/api/src/`:
```bash
git mv apps/web/src/ai apps/api/src/ai
git mv apps/web/src/lib/modelPicker.ts apps/api/src/lib/modelPicker.ts
git mv apps/web/src/lib/observability apps/api/src/lib/observability
git mv apps/web/src/server/db.ts apps/api/src/server/db.ts
git mv apps/web/src/server/share apps/api/src/server/share
```

**Phase C — Add JWT verifier in Express, port one route**

1. Write `apps/api/src/middleware/jwt.ts` (Section 7).
2. Write `apps/api/src/index.ts` (Section 9).
3. Port `/v1/generate/outline` first — easiest streaming endpoint.
4. Add `/api/auth/jwt/route.ts` in `apps/web` to expose the raw JWT to the client.
5. Update `PresentationGenerationManager` to point `useChat` at `${NEXT_PUBLIC_API_URL}/v1/generate/outline` with `Authorization` header.
6. `pnpm -F web dev` and `pnpm -F api dev`. Confirm outline streams end-to-end.

**Phase D — Port remaining streaming endpoints**

Outline → presentation → slide → image-slides → diagrams ×3 → agent → search.

For each: copy the route body, replace request/response shape, replace `auth()` with `req.user`, replace `createUIMessageStreamResponse` with `pipeUIMessageStreamToResponse`. Test in browser before moving on.

**Phase E — Port persistence (server actions → REST)**

Presentations → themes → font pairs → images. Add corresponding `api.*` methods in `apps/web/src/lib/api.ts`. Replace each server-action import with `api.*`. Search-and-replace by import path:

```bash
grep -RIn "from '@/app/_actions" apps/web/src
```

For each match, swap to `api.foo.bar(...)`.

**Phase F — Remove backend deps from `apps/web`**

```bash
cd apps/web
pnpm remove @prisma/client prisma langchain @langchain/core @langchain/openai \
  @langchain/langgraph @langchain/langgraph-checkpoint-postgres \
  @langchain/pinecone @ai-sdk/langchain @tavily/core @fal-ai/client \
  together-ai pg ollama-ai-provider
rm -rf src/ai src/lib/modelPicker.ts src/lib/observability src/server/db.ts src/server/share src/app/api/agent src/app/api/presentation src/app/_actions
```

**Phase G — Polish**

- Add CORS for production origin.
- Add `nginx`/Cloudflare config to disable buffering on `/v1/generate/*`, `/v1/agent/*`, `/v1/diagrams/*`.
- Add a pino-http logger to Express; expose `/health` and `/ready`.
- Add basic per-IP rate limiter (`express-rate-limit`) on `/v1/generate/*`.
- Document the API in `apps/api/README.md`.

---

## 11. Environment variables — who needs what

**`apps/web/.env`**
```
NEXTAUTH_SECRET=<shared>
NEXTAUTH_URL=https://app.example.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
NEXT_PUBLIC_API_URL=https://api.example.com
UPLOADTHING_TOKEN=...
```

**`apps/api/.env`**
```
NEXTAUTH_SECRET=<shared>             # MUST match apps/web
DATABASE_URL=postgresql://...
WEB_ORIGIN=https://app.example.com
PORT=3001
OPENAI_API_KEY=...
OPENROUTER_API_KEY=...
TOGETHER_AI_API_KEY=...
FAL_API_KEY=...
TAVILY_API_KEY=...
UNSPLASH_ACCESS_KEY=...
PIXABAY_API_KEY=...
GIPHY_API_KEY=...
PINECONE_API_KEY=...                 # if used
GOOGLE_GENAI_API_KEY=...             # for diagrams (Gemini)
```

The web app no longer needs any model API keys, no `DATABASE_URL`, no Tavily key, etc.

---

## 12. Verification checklist

**Per-endpoint smoke tests (curl):**
```bash
# 1. Mint a JWT — easiest is to sign in at the web app, then GET /api/auth/jwt
JWT=$(curl -s -b "$COOKIES" http://localhost:3000/api/auth/jwt | jq -r .token)

# 2. Streaming
curl -N -X POST http://localhost:3001/v1/generate/outline \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A talk about pufferfish","numberOfCards":5,"language":"en-US"}'

# 3. CRUD
curl http://localhost:3001/v1/presentations -H "Authorization: Bearer $JWT"

# 4. Public (no header)
curl http://localhost:3001/v1/presentations/<id>/shared
```

**End-to-end golden path (browser):**
1. Sign in via Google → land on dashboard → list loads from Express.
2. Create presentation → outline streams → confirm → full slide generation streams → slides render → auto-save round-trips.
3. Open present mode → start agent chat → tool calls (`replace_image`, `edit_slide_properties`) execute and update slides live.
4. Open `/share/presentation/<id>` for a public presentation in incognito → loads without auth.

**Regression sweeps:**
- Theme creation, favorite, like.
- Font pair upload (UploadThing → CDN URL → POST `/v1/font-pairs`).
- PPTX export (client-side; should be unaffected).
- `pnpm -F web type` and `pnpm -F api type` both clean.

**Service reusability check:**
Mint a JWT signed with `NEXTAUTH_SECRET` from a scratch project and hit `/v1/generate/outline`. If it streams, the service is genuinely reusable.

---

## 13. Out of scope (future work)

- API keys / OAuth client-credentials flow for non-Next consumers.
- Moving UploadThing into Express.
- Splitting Prisma schema across two DBs (AI-state vs user data).
- Per-tenant rate limiting / billing / quotas.
- OpenAPI spec generation from the zod schemas in `packages/shared`.
- **Decision needed:** local model discovery (Ollama/LM Studio) currently probes `localhost`. Once moved to Express, that means *the API host's localhost*, not the user's. If browser-local discovery is required, leave `/v1/models/local` as a Next.js route or call Ollama directly from the browser.
