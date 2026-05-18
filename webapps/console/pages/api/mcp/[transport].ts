import { mcpServer } from "../../../lib/server/mcp-server";

export const config = {
  api: {
    // The MCP SDK transport reads/writes the raw body itself.
    bodyParser: false,
  },
};

export default (req, res) => mcpServer.handleMcpRequest(req, res);
