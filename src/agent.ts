import { Agent, callable } from "agents";
import {
  CONTEXT_WINDOW,
  INSIGHTS_EVERY_N_USER_MESSAGES,
  MODEL,
  initialState,
  systemPrompt,
  type BuddyState,
  type ChatMessage,
  type LearnerProfile,
  type Role
} from "./shared";

/**
 * One FinanceBuddy instance (a SQLite-backed Durable Object) exists per chat session.
 * - Short-term memory: every message is stored in the embedded SQLite table `messages`.
 * - Long-term memory: `state.profile` + `state.summary`, written by the InsightsWorkflow.
 */
export class FinanceBuddy extends Agent<Env, BuddyState> {
  initialState: BuddyState = initialState();

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`;
  }

  // ---------- HTTP API (routed by routeAgentRequest: /agents/finance-buddy/:session/:action) ----------

  async onRequest(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.split("/").filter(Boolean).pop();

    try {
      if (request.method === "POST" && action === "chat") {
        const body = (await request.json()) as { message?: string };
        const message = (body.message ?? "").trim();
        if (!message) return json({ error: "message is required" }, 400);
        if (message.length > 4000) return json({ error: "message too long" }, 400);
        return await this.chat(message);
      }
      if (request.method === "GET" && action === "history") {
        return json({ messages: this.getMessages(200), state: this.state });
      }
      if (request.method === "GET" && action === "state") {
        return json({ state: this.state });
      }
      if (request.method === "POST" && action === "insights") {
        const workflowId = await this.startInsights();
        return json({ workflowId, state: this.state });
      }
      if (request.method === "POST" && action === "reset") {
        this.resetMemory();
        return json({ ok: true, state: this.state });
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error("FinanceBuddy error", err);
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  // ---------- Chat ----------

  private async chat(userMessage: string): Promise<Response> {
    this.saveMessage("user", userMessage);

    const history = this.getMessages(CONTEXT_WINDOW).map((m) => ({ role: m.role, content: m.content }));
    const messages = [{ role: "system" as const, content: systemPrompt(this.state) }, ...history];

    const aiStream = (await this.env.AI.run(MODEL, {
      messages,
      stream: true,
      max_tokens: 700,
      temperature: 0.6
    })) as ReadableStream<Uint8Array>;

    // Re-stream Workers AI's SSE as plain text to the browser, and persist the full reply when done.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const pump = async () => {
      let full = "";
      try {
        for await (const token of parseSSE(aiStream)) {
          full += token;
          await writer.write(encoder.encode(token));
        }
      } catch (err) {
        console.error("stream error", err);
        const note = "\n\n[Sorry — the response was interrupted. Please try again.]";
        full += note;
        await writer.write(encoder.encode(note)).catch(() => {});
      } finally {
        if (full.trim()) this.saveMessage("assistant", full.trim());
        await writer.close().catch(() => {});
        await this.afterTurn();
      }
    };
    this.ctx.waitUntil(pump());

    return new Response(readable, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
  }

  /** Coordination: kick off the insights Workflow every N user messages. */
  private async afterTurn() {
    const insights = {
      ...this.state.insights,
      messagesSinceLastRun: this.state.insights.messagesSinceLastRun + 1
    };
    this.setState({ ...this.state, insights });
    if (insights.messagesSinceLastRun >= INSIGHTS_EVERY_N_USER_MESSAGES && insights.status !== "running") {
      await this.startInsights().catch((e) => console.error("auto insights failed", e));
    }
  }

  private async startInsights(): Promise<string> {
    if (this.state.insights.status === "running" && this.state.insights.workflowId) {
      return this.state.insights.workflowId;
    }
    const workflowId = await this.runWorkflow("INSIGHTS_WORKFLOW", { session: this.name });
    this.setState({
      ...this.state,
      insights: { ...this.state.insights, status: "running", workflowId, lastError: null }
    });
    return workflowId;
  }

  // ---------- RPC methods used by InsightsWorkflow ----------

  @callable()
  getTranscript(limit = 40): { messages: ChatMessage[]; profile: LearnerProfile; summary: string } {
    return { messages: this.getMessages(limit), profile: this.state.profile, summary: this.state.summary };
  }

  @callable()
  applyInsights(update: { profile: LearnerProfile; summary: string }) {
    this.setState({
      profile: update.profile,
      summary: update.summary,
      insights: {
        status: "idle",
        workflowId: null,
        lastRunAt: new Date().toISOString(),
        lastError: null,
        messagesSinceLastRun: 0
      }
    });
    return { ok: true };
  }

  @callable()
  markInsightsFailed(message: string) {
    this.setState({
      ...this.state,
      insights: { ...this.state.insights, status: "error", workflowId: null, lastError: message }
    });
  }

  // ---------- helpers ----------

  private saveMessage(role: Role, content: string) {
    this.sql`INSERT INTO messages (role, content) VALUES (${role}, ${content})`;
  }

  private getMessages(limit: number): ChatMessage[] {
    const rows = this.sql<ChatMessage>`
      SELECT id, role, content, created_at FROM messages ORDER BY id DESC LIMIT ${limit}`;
    return rows.reverse();
  }

  private resetMemory() {
    this.sql`DELETE FROM messages`;
    this.setState(initialState());
  }
}

/** Parse the Server-Sent Events stream returned by Workers AI into text tokens. */
async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as { response?: string };
          if (parsed.response) yield parsed.response;
        } catch {
          /* ignore keep-alives / partial lines */
        }
      }
    }
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
