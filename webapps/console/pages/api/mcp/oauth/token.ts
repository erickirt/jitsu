import { mcpServer } from "../../../../lib/server/mcp-server";

export default (req, res) => mcpServer.handleToken(req, res);
