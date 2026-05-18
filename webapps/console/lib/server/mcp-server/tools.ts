import type { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Harness stub. Real Jitsu tools land in follow-up PRs; for now we register
// a single tool that proves the auth path works end-to-end.
export function registerTools(sdkServer: SdkMcpServer) {
  sdkServer.registerTool(
    "whoami",
    {
      title: "Who am I?",
      description: "Return the authenticated Jitsu user attached to this MCP session.",
      inputSchema: {},
    },
    async (_args, ctx) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(ctx.authInfo?.extra ?? { error: "no auth info" }, null, 2),
        },
      ],
    })
  );
}
