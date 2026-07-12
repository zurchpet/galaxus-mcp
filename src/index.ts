#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GalaxusClient, GalaxusError, type Language, type Portal } from "./client.js";
import { buildTools } from "./tools.js";

const portal = (process.env.GALAXUS_PORTAL as Portal) ?? "galaxus";
const language = (process.env.GALAXUS_LANGUAGE as Language) ?? "en";

const client = new GalaxusClient({ portal, language });

const server = new McpServer({
  name: "galaxus-mcp",
  version: "0.1.0",
});

for (const tool of buildTools(client)) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.schema as any,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args: any) => {
      try {
        const result = await (tool.handler as (a: any) => Promise<unknown>)(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message =
          error instanceof GalaxusError
            ? [error.message, error.hint].filter(Boolean).join(" ")
            : error instanceof Error
              ? error.message
              : String(error);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
