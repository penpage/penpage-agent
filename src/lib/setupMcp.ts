import { homedir } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

const CLAUDE_DIR = join(homedir(), '.claude');

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return {}; }
}

/** exec 指令的共用 template */
function execCmd(agentDir: string, command: string) {
  return `cd ${agentDir} && node --no-deprecation --import tsx src/bin/cli.ts exec "${command}" --cwd "$OLDPWD" 2>/dev/null`;
}

/** Skill 定義 */
interface SkillDef {
  name: string;
  description: string;
  argumentHint?: string;
  command: string; // ppage-agent slash command pattern，$ARGUMENTS 會被替換
}

const SKILLS: SkillDef[] = [
  {
    name: 'ls',
    description: 'List recent pages, sessions, and plans',
    argumentHint: '[page|session|plan]',
    command: '/ls $ARGUMENTS',
  },
  {
    name: 'diag',
    description: 'Show Claude Code diagnostics and rate limits',
    command: '/diag',
  },
  {
    name: 'page',
    description: 'List, switch, or create .penpage pages',
    argumentHint: '[info|new <name>|<number>|<name>]',
    command: '/page $ARGUMENTS',
  },
  {
    name: 'session',
    description: 'Show session list or details with token usage',
    argumentHint: '[<number>|info <number>]',
    command: '/session $ARGUMENTS',
  },
];

/** MCP tool 權限 rules */
const MCP_PERMISSIONS = [
  'mcp__ppage-agent__ls',
  'mcp__ppage-agent__diag',
  'mcp__ppage-agent__page',
  'mcp__ppage-agent__system-info',
  'mcp__ppage-agent__session',
];

// --- Setup functions ---

/** 1. MCP 設定：~/.claude/.mcp.json */
function setupMcpJson(agentDir: string): boolean {
  const mcpPath = join(CLAUDE_DIR, '.mcp.json');
  const config = readJson(mcpPath);
  if (config.mcpServers?.['ppage-agent']) return false;

  config.mcpServers = config.mcpServers || {};
  config.mcpServers['ppage-agent'] = {
    command: 'bash',
    args: ['-c', `cd ${agentDir} && exec node --no-deprecation --import tsx src/bin/cli.ts mcp`],
  };

  ensureDir(CLAUDE_DIR);
  writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n');
  return true;
}

/** 2. Skills 安裝：~/.claude/skills/<name>/SKILL.md */
function setupSkills(agentDir: string): string[] {
  const installed: string[] = [];

  for (const skill of SKILLS) {
    const skillDir = join(CLAUDE_DIR, 'skills', skill.name);
    const skillPath = join(skillDir, 'SKILL.md');
    if (existsSync(skillPath)) continue;

    ensureDir(skillDir);
    const hint = skill.argumentHint ? `\nargument-hint: ${skill.argumentHint}` : '';
    const content = `---
name: ${skill.name}
description: ${skill.description}${hint}
allowed-tools: Bash(node *)
---

Run this command and display the output as-is, no commentary:

${execCmd(agentDir, skill.command)}
`;
    writeFileSync(skillPath, content);
    installed.push(skill.name);
  }

  return installed;
}

/** 3. 權限設定：~/.claude/settings.json */
function setupPermissions(): boolean {
  const settingsPath = join(CLAUDE_DIR, 'settings.json');
  const config = readJson(settingsPath);
  config.permissions = config.permissions || {};
  config.permissions.allow = config.permissions.allow || [];

  const allow: string[] = config.permissions.allow;
  const toAdd = MCP_PERMISSIONS.filter(r => !allow.includes(r));
  if (toAdd.length === 0) return false;

  config.permissions.allow.push(...toAdd);
  writeFileSync(settingsPath, JSON.stringify(config, null, 2) + '\n');
  return true;
}

/**
 * 啟動時一次設定 MCP + Skills + Permissions。
 * 每項都先檢查是否已存在，存在就跳過。
 */
export function ensureMcpConfig(agentDir: string) {
  const results: string[] = [];

  if (setupMcpJson(agentDir)) results.push('.mcp.json');
  const skills = setupSkills(agentDir);
  if (skills.length > 0) results.push(`skills: ${skills.join(', ')}`);
  if (setupPermissions()) results.push('permissions');

  if (results.length > 0) {
    console.log(`  Claude: auto-configured ${results.join(' | ')}`);
    console.log('  Claude: restart Claude CLI to apply changes');
  }
}
