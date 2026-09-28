# cf_ai_finance_buddy — FinBuddy

An AI-powered **personal-finance study companion** built entirely on Cloudflare.
You chat (by typing or by voice) about mutual funds, SIPs, index funds, ELSS, NAV, expense ratios and so on.
FinBuddy answers with **Llama 3.3 on Workers AI**, keeps the full conversation in a **per-session Durable Object (Agent)**,
and every few messages runs a **Cloudflare Workflow** that distils the chat into long-term memory
(your goals, risk appetite, horizon, experience level, topics covered, open questions). That memory is fed back
into the system prompt, so answers get more personal the longer you use it.

> Educational tool only — it does not give financial advice.

## How it maps to the assignment

| Required component | Implementation |
|---|---|
| **LLM** | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on Workers AI — streaming chat replies + JSON memory extraction |
| **Workflow / coordination** | `InsightsWorkflow` (Cloudflare Workflows, via `AgentWorkflow` from the Agents SDK) — durable, retryable steps: load transcript → LLM distil → validate → save. The Agent triggers it automatically every 4 user messages or on demand |
| **User input (chat or voice)** | Static chat UI in `public/` served by Workers Static Assets (Pages-style). Text chat with token streaming, plus voice input through the browser Web Speech API |
| **Memory / state** | `FinanceBuddy` Agent (SQLite-backed Durable Object), one per session: short-term memory = `messages` SQL table; long-term memory = Agent state (`profile`, `summary`) |

## Architecture

```
Browser (public/: chat + voice UI)
   │  POST /agents/finance-buddy/:session/chat      (streamed text)
   │  GET  /agents/finance-buddy/:session/history|state
   │  POST /agents/finance-buddy/:session/insights|reset
   ▼
Worker (src/index.ts) ── routeAgentRequest ──► FinanceBuddy Agent / Durable Object (src/agent.ts)
                                                 │  • SQLite: messages table (chat history)
                                                 │  • state: profile + summary + workflow status
                                                 │  • builds prompt = system + memory + last 12 msgs
                                                 │  • streams Llama 3.3 reply, saves it
                                                 │  • every 4 user msgs → runWorkflow()
                                                 ▼
                                   InsightsWorkflow (src/workflow.ts)
                                     1. load-transcript   (RPC → Agent.getTranscript)
                                     2. distil-memory     (Llama 3.3 → JSON, 3 retries, backoff)
                                     3. validate          (schema coercion, dedupe, caps)
                                     4. save-memory       (RPC → Agent.applyInsights)
```

Files:

- `src/index.ts` — Worker entry; routes `/agents/*` to the Agent, everything else to static assets.
- `src/agent.ts` — `FinanceBuddy` Agent: chat endpoint, SSE→text streaming, SQL history, workflow triggering, RPC methods.
- `src/workflow.ts` — `InsightsWorkflow`: multi-step memory distillation.
- `src/shared.ts` — types, model ID, prompts.
- `public/` — chat UI (`index.html`, `app.js`, `styles.css`), no build step.
- `test/` — local harness that swaps Workers AI for a mock so the flow runs without a Cloudflare account.

## Running it

**Prerequisites:** Node.js 20+, a Cloudflare account (free plan works) with Workers AI enabled.

```bash
npm install
npx wrangler login          # needed because Workers AI runs remotely even in local dev
npm run dev                 # http://localhost:8787
```

Open http://localhost:8787 and start chatting. Try:

1. "I'm new to investing. I want to build ₹50L for retirement in 20 years."
2. "What is a SIP and how does compounding help?"
3. "Should I pick an index fund or an active fund?"
4. "What's an expense ratio?"

After the 4th message the badge in the right panel shows **updating memory…** while the Workflow runs, then the
summary and learner profile fill in. Reload the page — history and memory persist (same session ID in `localStorage`).
Add `?session=anything` to the URL to open a separate session. Click **Update memory now** to run the Workflow
on demand, or **Forget everything** to wipe the session.

Voice: click 🎤 (Chrome/Edge/Safari — uses the browser's speech recognition) and speak; the message is sent when you stop.

### Deploy

```bash
npm run deploy
```

Wrangler creates the Worker, the Durable Object class (SQLite migration `v1`) and the `session-insights` Workflow.
The URL is printed at the end (e.g. `https://cf-ai-finance-buddy.<your-subdomain>.workers.dev`).

### Run without a Cloudflare account (mock LLM)

```bash
npm run dev:mock            # uses test/wrangler.test.jsonc, Workers AI replaced by a mock entrypoint
```

Everything else (Durable Object, SQLite, Workflow, UI) runs locally in Miniflare, which is handy for checking
the orchestration end-to-end.

### Other scripts

```bash
npm run typecheck           # tsc --noEmit
npm run typegen             # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

## API

All routes are scoped to a session: `/agents/finance-buddy/:session/...`

| Method | Path | Description |
|---|---|---|
| POST | `/chat` | Body `{ "message": "..." }`. Returns the assistant reply as a streamed `text/plain` body |
| GET | `/history` | `{ messages, state }` |
| GET | `/state` | `{ state }` — profile, summary, workflow status |
| POST | `/insights` | Start the memory Workflow now; returns `{ workflowId, state }` |
| POST | `/reset` | Delete history and memory for the session |

## Design notes

- **Why a Workflow for memory?** Memory extraction is a slower, failure-prone LLM call. Running it off the chat path keeps
  replies fast, and Workflow steps are checkpointed — if saving fails, the LLM step isn't re-run.
- **Bounded context:** only the last 12 messages go to the model; older context survives as the Workflow's summary.
- **Defensive parsing:** model JSON is extracted, coerced to allowed enums, deduplicated and capped before it reaches state.
- **Privacy:** the extraction prompt tells the model not to record identifiers like PAN, account numbers or income.
