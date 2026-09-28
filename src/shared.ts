export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;

/** How many recent messages are sent to the LLM as short-term memory. */
export const CONTEXT_WINDOW = 12;

/** Run the insights workflow automatically after this many new user messages. */
export const INSIGHTS_EVERY_N_USER_MESSAGES = 4;

export type Role = "user" | "assistant";

export interface ChatMessage {
  id: number;
  role: Role;
  content: string;
  created_at: string;
}

/** Long-term memory the Workflow distils from the conversation. */
export interface LearnerProfile {
  goals: string[];
  riskAppetite: "unknown" | "low" | "moderate" | "high";
  investmentHorizon: string;
  experienceLevel: "unknown" | "beginner" | "intermediate" | "advanced";
  topicsCovered: string[];
  openQuestions: string[];
}

export interface BuddyState {
  profile: LearnerProfile;
  summary: string;
  insights: {
    status: "idle" | "running" | "error";
    workflowId: string | null;
    lastRunAt: string | null;
    lastError: string | null;
    messagesSinceLastRun: number;
  };
}

export const emptyProfile = (): LearnerProfile => ({
  goals: [],
  riskAppetite: "unknown",
  investmentHorizon: "unknown",
  experienceLevel: "unknown",
  topicsCovered: [],
  openQuestions: []
});

export const initialState = (): BuddyState => ({
  profile: emptyProfile(),
  summary: "",
  insights: {
    status: "idle",
    workflowId: null,
    lastRunAt: null,
    lastError: null,
    messagesSinceLastRun: 0
  }
});

export function systemPrompt(state: BuddyState): string {
  const p = state.profile;
  const memory = [
    `Goals: ${p.goals.length ? p.goals.join("; ") : "not shared yet"}`,
    `Risk appetite: ${p.riskAppetite}`,
    `Investment horizon: ${p.investmentHorizon}`,
    `Experience level: ${p.experienceLevel}`,
    `Topics already covered: ${p.topicsCovered.length ? p.topicsCovered.join(", ") : "none"}`,
    `Open questions from earlier: ${p.openQuestions.length ? p.openQuestions.join("; ") : "none"}`
  ].join("\n");

  return `You are "FinBuddy", a friendly personal-finance study companion focused on the Indian market
(mutual funds, SIPs, index funds, ELSS, debt funds, NAV, expense ratio, asset allocation, compounding, tax basics).

How to answer:
- Teach, don't sell. Explain concepts in plain language with a small worked example (use INR, ₹) when useful.
- Adapt depth to the learner's experience level. Keep answers under ~200 words unless asked for more.
- Use what you remember about the learner (below) to personalise examples, but never invent facts about them.
- If they ask what to buy, explain the trade-offs and the questions to ask instead of naming a specific fund,
  and remind them briefly that this is educational, not financial advice.
- End with one short follow-up question or a suggested next topic when it helps learning.

What you remember about this learner (long-term memory):
${memory}

Summary of earlier conversation:
${state.summary || "This is the start of the conversation."}`;
}

export const INSIGHTS_PROMPT = `You maintain the long-term memory of a personal-finance tutoring assistant.
Given the PREVIOUS MEMORY and the RECENT TRANSCRIPT, return an updated memory as JSON only, with exactly these keys:
{
  "summary": string,              // 3-5 sentences: what the learner wanted and what was explained
  "goals": string[],              // financial goals the learner stated (e.g. "retirement corpus by 55")
  "riskAppetite": "unknown" | "low" | "moderate" | "high",
  "investmentHorizon": string,    // e.g. "10+ years" or "unknown"
  "experienceLevel": "unknown" | "beginner" | "intermediate" | "advanced",
  "topicsCovered": string[],      // short concept names, deduplicated, max 15
  "openQuestions": string[]       // things the learner asked that are not fully answered yet, max 5
}
Rules: only record what the learner actually said or clearly implied; keep previous facts unless contradicted;
never store account numbers, PAN, income figures or other sensitive identifiers. Output JSON only, no prose.`;
