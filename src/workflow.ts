import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import type { FinanceBuddy } from "./agent";
import { INSIGHTS_PROMPT, MODEL, emptyProfile, type LearnerProfile } from "./shared";

type Params = { session: string };

/**
 * Durable, retryable pipeline that turns the raw chat log into long-term memory:
 *   1. load transcript + previous memory from the Agent (RPC)
 *   2. ask Llama 3.3 to distil a summary and learner profile (JSON)
 *   3. validate/merge and write the result back into the Agent's state
 * Each step is checkpointed, so a failure in step 3 won't re-run the LLM call.
 */
export class InsightsWorkflow extends AgentWorkflow<FinanceBuddy, Params> {
  async run(event: AgentWorkflowEvent<Params>, step: AgentWorkflowStep) {
    try {
      const snapshot = await step.do("load-transcript", async () => {
        return await this.agent.getTranscript(40);
      });

      if (snapshot.messages.length === 0) return { skipped: true };

      const raw = await step.do(
        "distil-memory",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" },
        async () => {
          const transcript = snapshot.messages
            .map((m) => `${m.role === "user" ? "Learner" : "FinBuddy"}: ${m.content}`)
            .join("\n")
            .slice(-12000);

          const result = (await this.env.AI.run(MODEL, {
            messages: [
              { role: "system", content: INSIGHTS_PROMPT },
              {
                role: "user",
                content: `PREVIOUS MEMORY:\n${JSON.stringify({ summary: snapshot.summary, ...snapshot.profile })}\n\nRECENT TRANSCRIPT:\n${transcript}`
              }
            ],
            max_tokens: 800,
            temperature: 0.2
          })) as { response?: unknown };

          const text =
            typeof result.response === "string" ? result.response : JSON.stringify(result.response ?? {});
          return text;
        }
      );

      const update = await step.do("validate", async () => normalise(raw, snapshot.profile, snapshot.summary));

      await step.do("save-memory", async () => {
        await this.agent.applyInsights(update);
      });

      return { ok: true, topics: update.profile.topicsCovered.length };
    } catch (err) {
      await this.agent.markInsightsFailed(err instanceof Error ? err.message : String(err)).catch(() => {});
      throw err;
    }
  }
}

/** Extract JSON from the model output and coerce it into a safe LearnerProfile. */
function normalise(
  raw: string,
  previous: LearnerProfile,
  previousSummary: string
): { profile: LearnerProfile; summary: string } {
  const match = raw.match(/\{[\s\S]*\}/);
  let data: Record<string, unknown> = {};
  if (match) {
    try {
      data = JSON.parse(match[0]);
    } catch {
      data = {};
    }
  }

  const strList = (v: unknown, fallback: string[], max: number) =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim()))].slice(0, max)
      : fallback;
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

  const base = { ...emptyProfile(), ...previous };
  return {
    summary: typeof data.summary === "string" && data.summary.trim() ? data.summary.trim() : previousSummary,
    profile: {
      goals: strList(data.goals, base.goals, 8),
      riskAppetite: oneOf(data.riskAppetite, ["unknown", "low", "moderate", "high"] as const, base.riskAppetite),
      investmentHorizon:
        typeof data.investmentHorizon === "string" && data.investmentHorizon.trim()
          ? data.investmentHorizon.trim()
          : base.investmentHorizon,
      experienceLevel: oneOf(
        data.experienceLevel,
        ["unknown", "beginner", "intermediate", "advanced"] as const,
        base.experienceLevel
      ),
      topicsCovered: strList(data.topicsCovered, base.topicsCovered, 15),
      openQuestions: strList(data.openQuestions, base.openQuestions, 5)
    }
  };
}
