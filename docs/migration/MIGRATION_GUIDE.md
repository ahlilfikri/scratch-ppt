# Migration Guide — Split presentation-ai into Next.js (frontend) + Express (backend service) — Drizzle edition

## Context

`presentation-ai` is currently one Next.js 16 / React 19 app that owns UI + AI generation (LangChain + LangGraph + OpenAI/Together/FAL/Tavily/Gemini) + Postgres persistence (currently via **Prisma**) + NextAuth + UploadThing.

Goal: extract the backend so AI generation + persistence become **a reusable service any project can call over HTTP**, while the Next.js app becomes a pure UI client. As part of the split, **swap Prisma for Drizzle ORM**.

The split is feasible. The codebase is already shaped for it — every "backend-y" thing lives in `src/app/api/*`, `src/app/_actions/*`, `src/ai/*`, `src/server/*`, and `src/lib/modelPicker.ts`. UI ↔ backend seams are well defined: REST routes + server actions + AI-SDK `useChat`.

**Important:** the live Postgres database does not need to be migrated. Drizzle reads/writes the same tables Prisma already created. We only swap the access layer — `prisma.x.findMany(...)` → `db.query.x.findMany(...)`.

Decisions captured up front:
- **Service scope:** AI generation + persistence (Express owns AI *and* DB CRUD).
- **Auth:** JWT (reuse NextAuth). Next.js issues JWTs; Express verifies them with the shared `NEXTAUTH_SECRET`.
- **DB ownership:** Express owns all business-logic DB access. The only carve-out is the NextAuth adapter on apps/web, which writes to the auth tables (`User`, `Account`, `Session`, `VerificationToken`) during sign-in. Both apps use the same Drizzle schema, exported from `packages/shared`.
- **ORM:** Drizzle ORM + `drizzle-kit` for migrations. Existing Postgres data stays untouched.

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
9. Express bootstrap + Drizzle handler example
10. Phased migration plan with exact commands
11. Translating the Prisma schema to Drizzle (every model)
12. Environment variables — who needs what
13. Verification checklist
14. Out of scope (future work)

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
│   │       │   ├── (pages)/...
│   │       │   ├── api/
│   │       │   │   ├── auth/[...nextauth]/route.ts   # NextAuth — STAYS
│   │       │   │   ├── auth/jwt/route.ts             # NEW: returns raw JWT to client
│   │       │   │   └── uploadthing/                  # UploadThing — STAYS
│   │       │   └── share/
│   │       ├── components/
│   │       ├── states/
│   │       ├── hooks/
│   │       ├── lib/
│   │       │   ├── api.ts                # NEW: typed fetch wrapper to Express
│   │       │   └── auth-helpers.ts       # NEW: getJwtForCurrentSession()
│   │       ├── server/
│   │       │   ├── auth.ts               # NextAuth config + DrizzleAdapter
│   │       │   └── db.ts                 # tiny Drizzle instance for the adapter ONLY
│   │       └── env.js
│   └── api/                              # Express service — port 3001
│       ├── package.json
│       ├── tsconfig.json
│       ├── drizzle.config.ts             # points at packages/shared/src/db/schema.ts
│       ├── drizzle/                      # generated migration SQL files (drizzle-kit)
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
│               ├── db.ts                 # Drizzle instance for Express
│               └── share/
│                   └── authorization.ts  # MOVED, ported to Drizzle
└── packages/
    └── shared/
        ├── package.json
        └── src/
            ├── index.ts
            ├── db/
            │   ├── schema.ts             # canonical Drizzle schema (every table)
            │   └── relations.ts          # Drizzle relations
            ├── dtos/                     # PresentationDTO, ThemeDTO, ...
            └── schemas/                  # zod schemas for every request body
```

The Drizzle schema lives in `packages/shared` so both apps reference one source of truth. Migrations are owned by `apps/api` (`drizzle-kit` config there).

**Local dev:** `pnpm -F web dev` and `pnpm -F api dev` in two terminals (or `pnpm dev` at the root using `concurrently`).

**Deployment:** two separate processes. Frontend env: `NEXT_PUBLIC_API_URL=https://api.example.com`. CORS allowlist on Express points at the web origin.

---

## 2. Models — auth, data, contracts

### 2.1 Auth model (JWT-shared-secret)

NextAuth in `apps/web` already uses a JWT session strategy. Keep it. The flow is:

1. NextAuth signs the session JWT with `NEXTAUTH_SECRET` and stores it in an HTTP-only cookie.
2. NextAuth uses `@auth/drizzle-adapter` (replacing `@auth/prisma-adapter`) to persist `User`, `Account`, `Session`, `VerificationToken` rows on first sign-in. **This is the only DB access apps/web does.**
3. On every Express call, the frontend reads the JWT and attaches `Authorization: Bearer <jwt>`.
4. `apps/api` middleware verifies the JWT against the same `NEXTAUTH_SECRET` and attaches `req.user = { id, role, hasAccess, isAdmin }`. **JWT verification needs no DB access** — all required info is in the JWT claims (set by the NextAuth `jwt` callback).
5. Public endpoints (e.g. `GET /v1/presentations/:id/shared`) skip the middleware via a route-level allowlist.

> External (non-Next.js) consumers can either: (a) implement NextAuth flow and obtain a JWT, or (b) use a future `/auth/exchange` endpoint that swaps a service API key for a short-lived JWT. The verifier won't change.

### 2.2 Data model (Drizzle)

Drizzle defines tables as TypeScript values; types are inferred at compile time. Schema lives at `packages/shared/src/db/schema.ts`. Both apps import from it.

**Initial generation:** point `drizzle-kit pull` at the live Postgres to introspect the existing schema and emit `schema.ts` automatically:

```bash
# At apps/api/
pnpm drizzle-kit pull
```

This reads tables created by Prisma and produces a Drizzle schema that matches them column-for-column. You then clean it up by hand (rename JS field names, add relation helpers, attach index helpers, etc.). The full hand-written schema is in Section 11.

**Tables (unchanged from Prisma):** `User`, `Account`, `BaseDocument`, `Presentation`, `PresentationTheme` (mapped to table `CustomTheme`), `FavoritePresentationTheme`, `PresentationThemeLike`, `FontPair`, `FavoriteDocument`, `GeneratedImage`. NextAuth also expects `Session` and `VerificationToken` — these aren't in the current Prisma schema (because the project uses JWT strategy without DB sessions); add them only if you switch to database sessions.

`canEditDocument` / `canReadDocument` (currently `src/server/share/authorization.ts`) are ported to Drizzle queries and called from Express route handlers.

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
   │                                    │ DrizzleAdapter writes User+     │
   │                                    │ Account rows on first sign-in.  │
   │                                    │ Issues JWT signed with          │
   │                                    │ NEXTAUTH_SECRET, stored in      │
   │                                    │ HTTP-only `next-auth.session-   │
   │                                    │ token` cookie.                  │
   │ 2. set-cookie + redirect          │                                 │
   │◀───────────────────────────────────┤                                 │
   │                                    │                                 │
   │ 3. User opens dashboard           │                                 │
   ├───────────────────────────────────▶│                                 │
   │                                    │ /api/auth/jwt route returns     │
   │                                    │ the raw JWT to the client.      │
   │                                    │                                 │
   │ 4. fetch /v1/presentations        │                                 │
   │    Authorization: Bearer <jwt>    │                                 │
   ├────────────────────────────────────┴────────────────────────────────▶│
   │                                                                      │
   │                                                                      │ 5. jwtMiddleware verifies
   │                                                                      │    signature with NEXTAUTH_SECRET
   │                                                                      │    Attaches req.user
   │                                                                      │
   │                                                                      │ 6. handler queries Drizzle
   │                                                                      │    using req.user.id
   │                                                                      │
   │ 7. JSON response                                                     │
   │◀─────────────────────────────────────────────────────────────────────┤
```

NextAuth uses HS256 by default for JWT strategy. Express verifies the same algorithm. The JWT carries `sub`, `role`, `hasAccess`, `isAdmin` (set in the NextAuth `jwt` callback).

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

**Option A — `@ai-sdk/express` adapter (recommended).** Use `pipeUIMessageStreamToResponse(res, stream)`. The package mirrors what Next.js does for `Response`.

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
- **Flow:** entirely inside `apps/web`. NextAuth handles OAuth; `@auth/drizzle-adapter` upserts `User` + `Account` rows via the apps/web Drizzle instance.
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
- **Response:** SSE stream of markdown outline chunks.
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
- **Client effect:** XML parsed on the fly into slides and pushed into `presentation-state`. Each completed slide triggers `PATCH /v1/presentations/:id`. `<IMG>` placeholders trigger `POST /v1/images/generate` in parallel.

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
    messages: UIMessage[];
    presentationId: string;
    presentationContext: { slides: Slide[]; theme: string; ... };
    modelId?: string;
    modelProvider?: 'openai' | 'ollama' | 'lmstudio' | 'openrouter';
    webSearch?: boolean;
  }
  ```
- **Express responsibilities:**
  1. `jwtMiddleware`
  2. Verify `canEditDocument(req.user.id, presentationId)` (Drizzle query)
  3. Build LangGraph agent via `createAgent({ ... })` (ported from `src/ai/agents/presentation/createAgent.ts`)
  4. Use `PostgresSaver` checkpointer keyed on `thread_id = presentationId`. Same Postgres, separate tables (`@langchain/langgraph-checkpoint-postgres` creates them automatically — these tables are managed by LangGraph, not Drizzle).
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

### 5.9 Local & OpenRouter model discovery

- `GET /v1/models/local` → JSON list. Calls `localhost:11434/api/tags` (Ollama) and `localhost:1234/v1/models` (LM Studio) **on the Express host**.
- `GET /v1/models/openrouter` → JSON list, fetched from OpenRouter API.

> ⚠ Local model discovery via Express probes the API host's localhost, not the user's. If browser-local discovery is required, leave `/v1/models/local` as a Next.js route or call Ollama directly from the browser. See Section 14.

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
4. Express verifies `canEditDocument`, applies the partial via Drizzle, returns the updated row.

### 5.11 Public share (no auth)

- **Endpoint:** `GET /v1/presentations/:id/shared`
- **Auth:** none — middleware allowlisted.
- **Express responsibilities:** read presentation only if `isPublic = true`. If not, 404.
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
| `POST /v1/images/generate` | `{ prompt, model: 'fal'\|'together', size? }` | Calls FAL or Together; saves a `GeneratedImage` row via Drizzle; returns `{ url }`. |
| `GET /v1/images/unsplash?q=&page=` | — | Proxies Unsplash. |
| `GET /v1/images/pixabay?q=&page=` | — | Proxies Pixabay. |
| `GET /v1/images/giphy?q=&page=` | — | Proxies Giphy. |

All image-provider API keys live in `apps/api` only.

### 5.15 File upload (UploadThing — stays in Next.js)

1. User picks file → `<UploadButton>` POSTs to `/api/uploadthing` on Next.js (NextAuth `auth()` verifies session).
2. UploadThing returns the CDN URL.
3. Client posts the URL to `POST /v1/font-pairs` (or other) on Express. Express persists via Drizzle.

---

## 6. File-by-file mapping (old → new)

### Move (whole directories or files)

| From | To |
|---|---|
| `src/ai/` | `apps/api/src/ai/` |
| `src/lib/modelPicker.ts` | `apps/api/src/lib/modelPicker.ts` |
| `src/lib/observability/` | `apps/api/src/lib/observability/` |
| `src/server/share/authorization.ts` | `apps/api/src/server/share/authorization.ts` |

### Rewrite (different ORM)

| From | To | Notes |
|---|---|---|
| `prisma/schema.prisma` | `packages/shared/src/db/schema.ts` + `packages/shared/src/db/relations.ts` | See Section 11 — full Drizzle schema |
| `src/server/db.ts` (Prisma client) | `apps/api/src/server/db.ts` (Drizzle instance) + `apps/web/src/server/db.ts` (Drizzle instance for adapter only) | Two instances, same schema |
| `src/server/auth.ts` | Split: NextAuth config → `apps/web/src/server/auth.ts` (now uses `DrizzleAdapter`); JWT verifier → `apps/api/src/server/auth.ts` | |

### Convert (server actions / routes → Express handlers, queries Prisma → Drizzle)

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
- `src/server/share/`
- `src/ai/`, `src/lib/modelPicker.ts`, `src/lib/observability/`
- `prisma/` (entire directory — schema, migrations folder)
- Remove from `apps/web/package.json`: `@prisma/client`, `prisma`, `@auth/prisma-adapter`, `langchain`, `@langchain/*`, `@ai-sdk/langchain`, `@tavily/core`, `@fal-ai/client`, `together-ai`, `pg`.
- Remove `prisma` block from any package.json (the `postinstall: prisma generate` script).

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
      salt: 'next-auth.session-token',          // verify against running app
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

> Verify NextAuth's actual salt/cookie convention against the running app — adjust `salt` to match.

---

## 8. Frontend `api.ts` wrapper code

`apps/web/src/lib/api.ts`:

```ts
import { getJwtForCurrentSession } from './auth-helpers';
import type { PresentationDTO, CreatePresentationBody } from '@presentation-ai/shared';

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

For client components, expose the JWT via `apps/web/src/app/api/auth/jwt/route.ts`:

```ts
import { getToken } from 'next-auth/jwt';
import { type NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const token = await req.cookies.get('next-auth.session-token')?.value;
  if (!token) return NextResponse.json({ token: null }, { status: 401 });
  return NextResponse.json({ token });
}
```

(Or use `getToken({ req, raw: true })` to re-encode.) The client fetches this once on mount and caches it in memory.

---

## 9. Express bootstrap + Drizzle handler example

### `apps/api/src/server/db.ts`

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@presentation-ai/shared/db/schema';
import * as relations from '@presentation-ai/shared/db/relations';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema: { ...schema, ...relations } });
export type DB = typeof db;
```

### `apps/web/src/server/db.ts` (NextAuth adapter only)

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@presentation-ai/shared/db/schema';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
```

### `apps/web/src/server/auth.ts`

```ts
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from './db';

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: DrizzleAdapter(db),
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  session: { strategy: 'jwt' },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // first sign-in: load auth fields from DB
        const [row] = await db.query.users.findMany({
          where: (u, { eq }) => eq(u.id, user.id!),
          limit: 1,
        });
        if (row) {
          token.role = row.role;
          token.hasAccess = row.hasAccess;
          token.isAdmin = row.role === 'ADMIN';
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.sub!;
      session.user.role = token.role;
      session.user.hasAccess = token.hasAccess;
      session.user.isAdmin = token.isAdmin;
      return session;
    },
  },
});
```

### `apps/api/src/index.ts`

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

app.use('/v1', jwtMiddleware);
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

### Example route handler — `apps/api/src/routes/presentations.ts`

```ts
import { Router } from 'express';
import { eq, and, desc, lt } from 'drizzle-orm';
import { db } from '../server/db.js';
import { presentations, baseDocuments } from '@presentation-ai/shared/db/schema';
import { canEditDocument, canReadDocument } from '../server/share/authorization.js';
import { UpdatePresentationSchema } from '@presentation-ai/shared';
import type { AuthedRequest } from '../middleware/jwt.js';

const router = Router();

router.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const { cursor, limit = '20' } = req.query as Record<string, string>;
    const rows = await db.query.baseDocuments.findMany({
      where: (doc, { eq, and, lt }) =>
        and(
          eq(doc.userId, req.user!.id),
          eq(doc.type, 'PRESENTATION'),
          cursor ? lt(doc.createdAt, new Date(cursor)) : undefined,
        ),
      with: { presentation: true },
      orderBy: (doc, { desc }) => desc(doc.createdAt),
      limit: Number(limit),
    });
    const nextCursor = rows.length === Number(limit)
      ? rows[rows.length - 1].createdAt.toISOString()
      : null;
    res.json({ items: rows, nextCursor });
  } catch (e) { next(e); }
});

router.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const ok = await canReadDocument(req.user!.id, req.params.id);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    const row = await db.query.presentations.findFirst({
      where: eq(presentations.id, req.params.id),
      with: { base: true },
    });
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const ok = await canEditDocument(req.user!.id, req.params.id);
    if (!ok) return res.status(403).json({ error: 'forbidden' });
    const body = UpdatePresentationSchema.parse(req.body);
    const [row] = await db
      .update(presentations)
      .set(body)
      .where(eq(presentations.id, req.params.id))
      .returning();
    res.json(row);
  } catch (e) { next(e); }
});

export default router;
```

### Example streaming handler — `apps/api/src/routes/generate.ts`

```ts
import { Router } from 'express';
import { pipeUIMessageStreamToResponse } from '@ai-sdk/express';
import { toUIMessageStream } from '@ai-sdk/langchain';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { modelPicker } from '../lib/modelPicker.js';
import { OutlineSchema } from '@presentation-ai/shared';
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

### Authorization helper port — `apps/api/src/server/share/authorization.ts`

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db.js';
import { baseDocuments } from '@presentation-ai/shared/db/schema';

export async function canEditDocument(userId: string, documentId: string) {
  const row = await db.query.baseDocuments.findFirst({
    where: eq(baseDocuments.id, documentId),
    columns: { userId: true },
  });
  return row?.userId === userId;
}

export async function canReadDocument(userId: string, documentId: string) {
  const row = await db.query.baseDocuments.findFirst({
    where: eq(baseDocuments.id, documentId),
    columns: { userId: true, isPublic: true },
  });
  if (!row) return false;
  return row.userId === userId || row.isPublic;
}
```

---

## 10. Phased migration plan with exact commands

### Phase A — Workspace skeleton (no behavior change yet)

```bash
# At repo root
mkdir -p apps/web apps/api/src packages/shared/src/db
git mv src apps/web/src
git mv next.config.js apps/web/
git mv next-env.d.ts apps/web/
git mv tailwind.config.ts apps/web/
git mv postcss.config.mjs apps/web/
git mv components.json apps/web/
git mv tsconfig.json apps/web/
git mv package.json apps/web/
# Keep prisma/ at root for now — we'll delete it after Drizzle is wired up
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
    "type": "pnpm -r type",
    "db:pull": "pnpm -F api drizzle-kit pull",
    "db:generate": "pnpm -F api drizzle-kit generate",
    "db:migrate": "pnpm -F api drizzle-kit migrate"
  }
}
```

### Phase B — Move the AI core (still using Prisma)

```bash
git mv apps/web/src/ai apps/api/src/ai
git mv apps/web/src/lib/modelPicker.ts apps/api/src/lib/modelPicker.ts
git mv apps/web/src/lib/observability apps/api/src/lib/observability
git mv apps/web/src/server/share apps/api/src/server/share
```

At this point `apps/api` doesn't run yet — bootstrap is in the next phase.

### Phase C — Wire Drizzle (replace Prisma entirely)

1. Install Drizzle in both apps:
   ```bash
   # apps/api
   pnpm -F api add drizzle-orm pg
   pnpm -F api add -D drizzle-kit @types/pg tsx typescript

   # apps/web
   pnpm -F web add drizzle-orm pg @auth/drizzle-adapter
   pnpm -F web add -D @types/pg
   pnpm -F web remove @auth/prisma-adapter @prisma/client prisma
   ```

2. Add `apps/api/drizzle.config.ts`:
   ```ts
   import type { Config } from 'drizzle-kit';

   export default {
     schema: '../../packages/shared/src/db/schema.ts',
     out: './drizzle',
     dialect: 'postgresql',
     dbCredentials: { url: process.env.DATABASE_URL! },
   } satisfies Config;
   ```

3. Generate the schema by introspecting the existing Prisma-managed DB:
   ```bash
   pnpm -F api drizzle-kit pull
   # This writes apps/api/drizzle/schema.ts. Move it:
   mv apps/api/drizzle/schema.ts packages/shared/src/db/schema.ts
   ```
   Clean up the introspected file: rename JS field names to camelCase, add the relations file (Section 11), align with the hand-written reference schema.

4. Create `apps/api/src/server/db.ts` and `apps/web/src/server/db.ts` (Section 9).

5. Rewrite `apps/web/src/server/auth.ts` to use `DrizzleAdapter` (Section 9).

6. Sanity-check by signing in: NextAuth should still upsert `User` + `Account` rows (now via Drizzle). The DB schema is unchanged — only the code path differs.

### Phase D — Add JWT verifier in Express, port one route end-to-end

1. Write `apps/api/src/middleware/jwt.ts` (Section 7).
2. Write `apps/api/src/index.ts` (Section 9).
3. Port `/v1/generate/outline` first — easiest streaming endpoint.
4. Add `/api/auth/jwt/route.ts` in `apps/web` to expose the raw JWT to the client.
5. Update `PresentationGenerationManager` to point `useChat` at `${NEXT_PUBLIC_API_URL}/v1/generate/outline` with `Authorization` header.
6. `pnpm -F web dev` and `pnpm -F api dev`. Confirm outline streams end-to-end.

### Phase E — Port remaining streaming endpoints

Outline → presentation → slide → image-slides → diagrams ×3 → agent → search.

For each: copy the route body, replace `request.json()` with `req.body`, replace `auth()` with `req.user`, replace `createUIMessageStreamResponse` with `pipeUIMessageStreamToResponse`. Test in browser before moving on.

### Phase F — Port persistence (server actions → REST + Prisma → Drizzle)

For each server action in `apps/web/src/app/_actions/**`:

1. Copy the function body into a new Express route handler.
2. Translate the Prisma query to Drizzle:
   - `prisma.presentation.findUnique({ where: { id } })` → `db.query.presentations.findFirst({ where: eq(presentations.id, id) })`
   - `prisma.presentation.findMany({ where: ..., orderBy: ..., take: 20 })` → `db.query.presentations.findMany({ where: ..., orderBy: ..., limit: 20 })`
   - `prisma.presentation.create({ data })` → `db.insert(presentations).values(data).returning()`
   - `prisma.presentation.update({ where, data })` → `db.update(presentations).set(data).where(...).returning()`
   - `prisma.presentation.delete({ where })` → `db.delete(presentations).where(...)`
   - `prisma.$transaction([...])` → `db.transaction(async (tx) => { ... })`
3. Add the corresponding `api.*` method in `apps/web/src/lib/api.ts`.
4. In the UI, replace each server-action import with `api.*`. Find them with:
   ```bash
   grep -RIn "from '@/app/_actions" apps/web/src
   ```

### Phase G — Remove Prisma & cleanup

```bash
# apps/web no longer touches Prisma
cd apps/web
pnpm remove langchain @langchain/core @langchain/openai @langchain/langgraph \
  @langchain/langgraph-checkpoint-postgres @langchain/pinecone \
  @ai-sdk/langchain @tavily/core @fal-ai/client together-ai pg ollama-ai-provider
rm -rf src/ai src/lib/modelPicker.ts src/lib/observability \
       src/server/share src/app/api/agent src/app/api/presentation src/app/_actions

# Delete Prisma schema and the postinstall script
cd ../..
rm -rf prisma
# Also remove `"postinstall": "prisma generate"` from any package.json
```

### Phase H — Polish

- Tighten CORS for production origin.
- Configure `nginx`/Cloudflare to disable buffering on `/v1/generate/*`, `/v1/agent/*`, `/v1/diagrams/*`.
- `pino-http` logger; expose `/health` and `/ready`.
- `express-rate-limit` on `/v1/generate/*`.
- Generate types: `drizzle-kit generate` (creates SQL migrations going forward).
- Document the API in `apps/api/README.md`.

---

## 11. Translating the Prisma schema to Drizzle (every model)

The current Prisma schema (`prisma/schema.prisma`) maps to this Drizzle file. Place at `packages/shared/src/db/schema.ts`.

```ts
import {
  pgTable, pgEnum, text, timestamp, integer, boolean, jsonb, varchar, uniqueIndex, index, primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const userRoleEnum = pgEnum('UserRole', ['ADMIN', 'USER']);

export const documentTypeEnum = pgEnum('DocumentType', [
  'NOTE', 'DOCUMENT', 'DRAWING', 'DESIGN', 'STICKY_NOTES',
  'MIND_MAP', 'RESEARCH_PAPER', 'FLIPBOOK', 'PRESENTATION',
]);

// ─── Auth tables (NextAuth uses these) ─────────────────────────────
export const users = pgTable('User', {
  id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
  name: text('name'),
  email: text('email').unique(),
  password: text('password'),
  emailVerified: timestamp('emailVerified', { mode: 'date' }),
  image: text('image'),
  createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().defaultNow(),
  headline: varchar('headline', { length: 100 }),
  bio: text('bio'),
  interests: text('interests').array().notNull().default(sql`ARRAY[]::text[]`),
  location: text('location'),
  website: text('website'),
  role: userRoleEnum('role').notNull().default('USER'),
  hasAccess: boolean('hasAccess').notNull().default(false),
});

export const accounts = pgTable(
  'Account',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('providerAccountId').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
    refresh_token_expires_in: integer('refresh_token_expires_in'),
  },
  (t) => [uniqueIndex('Account_provider_providerAccountId_key').on(t.provider, t.providerAccountId)],
);

// ─── Documents & presentations ─────────────────────────────────────
export const baseDocuments = pgTable('BaseDocument', {
  id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
  title: text('title').notNull(),
  type: documentTypeEnum('type').notNull(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  thumbnailUrl: text('thumbnailUrl'),
  createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().defaultNow(),
  isPublic: boolean('isPublic').notNull().default(false),
  documentType: text('documentType').notNull(),
});

export const presentations = pgTable('Presentation', {
  id: text('id').primaryKey().references(() => baseDocuments.id, { onDelete: 'cascade' }),
  content: jsonb('content').notNull(),
  theme: text('theme').notNull().default('mystique'),
  imageSource: text('imageSource').default('ai'),
  prompt: text('prompt'),
  presentationStyle: text('presentationStyle'),
  customization: jsonb('customization'),
  language: text('language').default('en-US'),
  outline: text('outline').array().notNull().default(sql`ARRAY[]::text[]`),
  searchResults: jsonb('searchResults'),
  templateId: text('templateId'),
});

// ─── Themes ────────────────────────────────────────────────────────
export const presentationThemes = pgTable(
  'CustomTheme',                   // matches Prisma's @@map
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    name: text('name').notNull(),
    description: text('description'),
    userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    logoUrl: text('logoUrl'),
    isPublic: boolean('isPublic').notNull().default(false),
    createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().defaultNow(),
    isAdmin: boolean('isAdmin').notNull().default(false),
    themeData: jsonb('themeData').notNull(),
  },
  (t) => [index('CustomTheme_userId_idx').on(t.userId)],
);

export const favoritePresentationThemes = pgTable(
  'FavoritePresentationTheme',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    themeId: text('themeId').notNull().references(() => presentationThemes.id, { onDelete: 'cascade' }),
    createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('FavoritePresentationTheme_userId_themeId_key').on(t.userId, t.themeId),
    index('FavoritePresentationTheme_userId_idx').on(t.userId),
    index('FavoritePresentationTheme_themeId_idx').on(t.themeId),
  ],
);

export const presentationThemeLikes = pgTable(
  'PresentationThemeLike',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    themeId: text('themeId').notNull().references(() => presentationThemes.id, { onDelete: 'cascade' }),
    createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('PresentationThemeLike_userId_themeId_key').on(t.userId, t.themeId),
    index('PresentationThemeLike_userId_idx').on(t.userId),
    index('PresentationThemeLike_themeId_idx').on(t.themeId),
  ],
);

// ─── Fonts ─────────────────────────────────────────────────────────
export const fontPairs = pgTable(
  'FontPair',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    heading: text('heading').notNull(),
    headingUrl: text('headingUrl'),
    headingWeight: integer('headingWeight').notNull().default(700),
    body: text('body').notNull(),
    bodyUrl: text('bodyUrl'),
    bodyWeight: integer('bodyWeight').notNull().default(400),
    userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('FontPair_userId_idx').on(t.userId)],
);

// ─── Favorites & generated images ──────────────────────────────────
export const favoriteDocuments = pgTable(
  'FavoriteDocument',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    documentId: text('documentId').notNull().references(() => baseDocuments.id, { onDelete: 'cascade' }),
    userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('FavoriteDocument_userId_documentId_key').on(t.userId, t.documentId)],
);

export const generatedImages = pgTable('GeneratedImage', {
  id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
  url: text('url').notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().defaultNow(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  prompt: text('prompt').notNull(),
});
```

`packages/shared/src/db/relations.ts`:

```ts
import { relations } from 'drizzle-orm';
import {
  users, accounts, baseDocuments, presentations,
  presentationThemes, favoritePresentationThemes, presentationThemeLikes,
  fontPairs, favoriteDocuments, generatedImages,
} from './schema';

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  documents: many(baseDocuments),
  favorites: many(favoriteDocuments),
  generatedImages: many(generatedImages),
  presentationThemes: many(presentationThemes),
  favoritePresentationThemes: many(favoritePresentationThemes),
  presentationThemeLikes: many(presentationThemeLikes),
  fontPairs: many(fontPairs),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const baseDocumentsRelations = relations(baseDocuments, ({ one, many }) => ({
  user: one(users, { fields: [baseDocuments.userId], references: [users.id] }),
  presentation: one(presentations),
  favorites: many(favoriteDocuments),
}));

export const presentationsRelations = relations(presentations, ({ one }) => ({
  base: one(baseDocuments, { fields: [presentations.id], references: [baseDocuments.id] }),
}));

export const presentationThemesRelations = relations(presentationThemes, ({ one, many }) => ({
  user: one(users, { fields: [presentationThemes.userId], references: [users.id] }),
  favorites: many(favoritePresentationThemes),
  likes: many(presentationThemeLikes),
}));

// (other relations follow the same pattern)
```

> **Critical detail:** the table names passed to `pgTable('Foo', ...)` must match the existing PostgreSQL table names *exactly*. Prisma uses PascalCase by default (`User`, `Account`, ...), so Drizzle must use the same. Note `presentationThemes` maps to **`CustomTheme`** because the Prisma model has `@@map("CustomTheme")`. The `userId`, `createdAt`, etc. column names are also case-sensitive Postgres identifiers — keep them as written.

---

## 12. Environment variables — who needs what

**`apps/web/.env`**
```
NEXTAUTH_SECRET=<shared>
NEXTAUTH_URL=https://app.example.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
NEXT_PUBLIC_API_URL=https://api.example.com
UPLOADTHING_TOKEN=...
DATABASE_URL=postgresql://...           # ⚠ also here, but ONLY for the DrizzleAdapter
```

**`apps/api/.env`**
```
NEXTAUTH_SECRET=<shared>                # MUST match apps/web
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
PINECONE_API_KEY=...
GOOGLE_GENAI_API_KEY=...                # for diagrams (Gemini)
```

> The web app needing `DATABASE_URL` is the carve-out from "DB owned by Express" — it's used by the NextAuth adapter only, on the server side, never exposed to the browser. If you want stricter separation, replace `@auth/drizzle-adapter` with a custom adapter that calls Express HTTP endpoints — see Section 14.

---

## 13. Verification checklist

**Per-endpoint smoke tests (curl):**
```bash
# 1. Mint a JWT — sign in at the web app, then GET /api/auth/jwt
JWT=$(curl -s -b "$COOKIES" http://localhost:3000/api/auth/jwt | jq -r .token)

# 2. Streaming
curl -N -X POST http://localhost:3001/v1/generate/outline \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A talk about pufferfish","numberOfCards":5,"language":"en-US"}'

# 3. CRUD (Drizzle-backed)
curl http://localhost:3001/v1/presentations -H "Authorization: Bearer $JWT"

# 4. Public (no header)
curl http://localhost:3001/v1/presentations/<id>/shared
```

**Drizzle/DB sanity:**
```bash
pnpm -F api drizzle-kit pull          # should produce no diff once schema is correct
psql $DATABASE_URL -c '\dt'           # tables unchanged
```

**End-to-end golden path (browser):**
1. Sign in via Google → DrizzleAdapter writes User+Account → land on dashboard → list loads from Express.
2. Create presentation → outline streams → confirm → full slide generation streams → slides render → auto-save round-trips through Express+Drizzle.
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

## 14. Out of scope (future work)

- Replace the apps/web Drizzle adapter with a custom HTTP adapter that calls Express, to remove the `DATABASE_URL` from apps/web entirely.
- API keys / OAuth client-credentials flow for non-Next consumers.
- Moving UploadThing into Express.
- Per-tenant rate limiting / billing / quotas.
- OpenAPI spec generation from the zod schemas in `packages/shared`.
- **Decision needed:** local model discovery (Ollama/LM Studio) currently probes `localhost`. Once moved to Express, that means *the API host's localhost*, not the user's. If browser-local discovery is required, leave `/v1/models/local` as a Next.js route or call Ollama directly from the browser.
- Going forward: write new schema changes in Drizzle (`drizzle-kit generate`) — no Prisma left to maintain.
