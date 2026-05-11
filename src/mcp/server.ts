import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { executeCommand } from '../server/commands.js';
import type { CommandContext } from '../server/commands.js';

/** 共用 helper：執行指令並回傳 MCP content */
async function run(name: string, args: string[], ctx: CommandContext) {
  const result = await executeCommand(name, args, ctx);
  return { content: [{ type: 'text' as const, text: result?.markdown ?? 'No result.' }] };
}

/**
 * 啟動 MCP stdio server，把 ppage-agent 的 slash commands 暴露為 MCP tools。
 * Claude CLI 透過 stdio 呼叫。
 */
export async function startMcpServer(cwd: string) {
  const server = new McpServer({
    name: 'ppage-agent',
    version: '0.1.0',
  });

  const ctx: CommandContext = {
    cwd,
    filename: 'mcp',
    sessionData: {},
  };

  // /ls — 列出 pages, sessions, plans
  server.tool(
    'ls',
    'List recent pages, sessions, and plans. Use sub to filter: "page", "session", or "plan". Leave empty for summary.',
    { sub: z.string().optional().describe('Filter: "page", "session", or "plan". Empty for summary.') },
    async ({ sub }) => run('ls', sub ? [sub] : [], ctx),
  );

  // /diag — Claude Code 診斷
  server.tool(
    'diag',
    'Show Claude Code diagnostics: version, model, rate limits, and recent usage stats.',
    {},
    async () => run('diag', [], ctx),
  );

  // /page — 管理 .penpage pages
  server.tool(
    'page',
    'Manage .penpage pages. No args: list all. "info": show session details. "new <name>": create page. Number or name: switch page.',
    { args: z.string().optional().describe('Subcommand: empty=list, "info", "new <name>", number, or page name.') },
    async ({ args }) => run('page', args ? args.split(/\s+/) : [], ctx),
  );

  // /session — session 列表、恢復、詳情
  server.tool(
    'session',
    'Show session list or details with token usage. No args: list sessions. "info N": show session N details.',
    { args: z.string().optional().describe('Subcommand: empty=list, "info N"=details, number=limit.') },
    async ({ args }) => run('session', args ? args.split(/\s+/) : [], ctx),
  );

  // 系統資訊指令
  server.tool(
    'system-info',
    'Run system diagnostics. Commands: ping, uptime, df (disk), who (user+host), ip (external IP), mem (memory).',
    { command: z.enum(['ping', 'uptime', 'df', 'who', 'ip', 'mem']).describe('System command to run.') },
    async ({ command }) => run(command, [], ctx),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
