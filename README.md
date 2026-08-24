# Migration: Google (Gemini/Veo) → Fal.ai

## Setup
```
npm install
cp .env.example .env   # fill in FAL_KEY
node server.js
```

## What changed

**Vendor layer (`fal-client.js`, new)** — replaces the old Gemini/Veo
wrapper functions (`geminiImageRequest`, `resilientImageGeneration`,
`geminiTextRequest`, `toInlineImagePart`, `generateVeoClip`,
`pollVeoOperation`, etc.) with Fal.ai equivalents that preserve the same
retry/backoff, circuit-breaker, cost-ledger, and progress-update behavior:
- `falImageRequest` / `resilientFalImageGeneration` — image generation via
  `fal.subscribe()`, with the same preferred→fallback model logic as before.
- `falTextRequest` / `falVisionRequest` — JSON/text reasoning and vision
  analysis via `fal-ai/any-llm` and `fal-ai/any-llm/vision` (Fal's
  OpenRouter-backed "run any LLM" endpoints), replacing Gemini text calls.
  Still uses the same "strict JSON + strip \`\`\`json fences" pattern.
- `falVideoRequest` — video generation via `fal.subscribe()`. Simpler than
  the old Veo path since Fal's client polls to completion internally (no
  separate `pollVeoOperation` needed); still downloads the result to local
  disk (`public/generated-videos/`) for permanence, since Fal's hosted URLs
  are only guaranteed available for a handful of days.

**Model registry (`fal-models.js`, new)** — curated list of Fal image/video
models (with confirmed endpoint IDs, pulled from Fal's own docs) that
back the frontend dropdowns via `GET /api/models`, plus per-model cost
estimates for the credits ledger. The server does **not** validate
incoming model IDs against this list, so the frontend's "Custom model
ID…" option (any of Fal's 500+ models) works transparently.

**Business/safety logic (`server.js`)** — unchanged in spirit. All the
prompt-engineering (`buildProductLockClause`, `buildShotSequence`, shot
framing, etc.), the two-stage moderation pipeline, the batch pipeline,
resumability (SQLite `run_items`), and the credits ledger structure are
carried over as-is; only the vendor calls inside them were swapped.

**New routes:**
- `GET /api/models` — serves the model registry to the frontend dropdowns.
- `POST /api/regenerate-frame` — regenerates a single already-generated
  image with an explicitly chosen model (backs the 🔄 control on each
  result card).

**Frontend (`app.js`)** — added:
- A "Custom model ID…" capable dropdown (`modelSelectHtml()`) reused
  everywhere a model choice is needed.
- Global "whole shoot / whole batch" default model dropdowns (injected via
  JS near the Generate buttons — `index.html` wasn't available for this
  migration, so these aren't hand-authored markup; see below).
- Per-card model overrides on the prompt-review cards (single mode),
  batch concept cards, and video-brief shot cards.
- A 🔄 regenerate-with-a-different-model control on every generated image
  card (single and batch results).
- Settings modal gained "Reasoning model" / "Vision model" override
  fields, injected next to the API key field (which is now a **Fal** key,
  not a Gemini key — same input/localStorage key name to avoid an
  `index.html` edit, just repointed).

## Things to verify before production

1. **Two model entries in `fal-models.js` are flagged `// verify slug`** —
   Seedream's edit endpoint and Kling 3.0 Pro's endpoint ID were not
   directly confirmed against a live Fal schema page during this
   migration (everything else was). Double check against
   https://fal.ai/models before relying on them.
2. **Cost estimates in `fal-models.js` are best-effort placeholders**
   for a couple of models (GPT Image 2, Seedream, Kling, and all
   `any-llm` text/vision calls use a flat $0.01 placeholder) — real
   per-model/per-token pricing should be pulled from your Fal dashboard.
3. **Fal's `image_urls` schema was confirmed for `nano-banana-pro/edit`**
   and assumed consistent for the other edit-capable models
   (`flux-2-pro/edit`, `gpt-image-2/edit`) — spot-check one generation per
   model type after `npm install`, since a wrong field name would show up
   immediately as an empty/error response rather than silently misbehaving.
4. **Veo's multi-reference-image mode on Fal** (`buildFalVideoInput`) is
   implemented with the same "try it, fall back to single-image anchor on
   failure" pattern the original Google code used, since the exact
   multi-image field name for combined-video mode wasn't confirmed live.

## Frontend model selection (`index.html` + `app.js`)

- **Settings modal** — the API key field is now labeled "Fal API Key"
  (same `#geminiKeyInput` element/localStorage key as before, just
  repointed at Fal), plus two new optional override fields for the
  reasoning model (`#falTextModelInput`) and vision model
  (`#falVisionModelInput`) used by `fal-ai/any-llm` / `fal-ai/any-llm/vision`.
- **Global defaults** — `#globalImageModelSelect` (single mode, in the
  prompt-review card), `#globalBatchImageModelSelect` (batch mode), and
  `#globalVideoModelSelect` (video brief modal) are static `<select>`
  elements populated at runtime from `GET /api/models`. Each has a
  "Custom model ID…" option that reveals a paired text input
  (`#globalImageModelCustom`, etc.) so any of Fal's 500+ models can be
  used, not just the curated few in `fal-models.js`.
- **Per-card overrides** — the prompt-review cards (single mode), batch
  concept cards, and video-brief shot cards each get their own model
  dropdown, built dynamically by `modelSelectHtml()` in `app.js` since
  those cards don't exist until a run produces them. A per-card choice
  overrides the global default for just that frame/shot.
- **Regenerate** — every generated image card (single and batch results)
  has a 🔄 control: pick a different model from its dropdown and it calls
  the new `POST /api/regenerate-frame` to re-render just that image.
