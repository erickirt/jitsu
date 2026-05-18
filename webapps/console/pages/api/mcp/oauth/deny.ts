import { mcpServer } from "../../../../lib/server/mcp-server";

export default (req, res) => mcpServer.handleDeny(req, res);
