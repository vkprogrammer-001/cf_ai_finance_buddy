// Local test harness only: replaces Workers AI with a deterministic mock so the
// Agent + Workflow + SQL memory flow can be exercised without a Cloudflare account.
import { WorkerEntrypoint } from "cloudflare:workers";
export { FinanceBuddy } from "../src/agent";
export { InsightsWorkflow } from "../src/workflow";
export { default } from "../src/index";

export class MockAI extends WorkerEntrypoint {
  async run(_model: string, input: { stream?: boolean; messages: { role: string; content: string }[] }) {
    if (input.stream) {
      const enc = new TextEncoder();
      const tokens = ["A SIP ", "invests a fixed ", "amount every month. ", "Want an example?"];
      return new ReadableStream({
        start(c) {
          for (const t of tokens) c.enqueue(enc.encode(`data: ${JSON.stringify({ response: t })}\n\n`));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        }
      });
    }
    return {
      response: 'Here you go: {"summary":"Learner asked about SIPs.","goals":["retirement by 55"],"riskAppetite":"moderate","investmentHorizon":"20 years","experienceLevel":"beginner","topicsCovered":["SIP","compounding","SIP"],"openQuestions":[]}'
    };
  }
}
