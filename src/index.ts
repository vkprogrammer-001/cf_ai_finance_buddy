import { routeAgentRequest } from "agents";

export { FinanceBuddy } from "./agent";
export { InsightsWorkflow } from "./workflow";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // /agents/finance-buddy/:sessionId/* -> the session's FinanceBuddy Durable Object
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    // Everything else: the static chat UI in /public
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
