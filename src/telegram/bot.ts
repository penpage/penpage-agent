import { Bot, Context } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseCommand, executeCommand, SessionData, ChatMessage } from '../server/commands.js';
import { runPrompt, RunResult, compactSession } from '../server/runners/execute.js';
import { formatSessionLine, formatLogLine, formatCompactInfo } from '../shared/formatSession.js';

/** 解析 AI prompt mode（/plan 或 /run 在開頭或結尾） */
function parseMode(text: string): { mode: 'plan' | 'run'; prompt: string } {
  const lines = text.trim().split('\n');
  const first = lines[0].trim();
  const last = lines[lines.length - 1].trim();

  if (first === '/plan' || first.startsWith('/plan ')) {
    return { mode: 'plan', prompt: text.replace(/^\/plan\s*/, '').trim() };
  }
  if (first === '/run' || first.startsWith('/run ')) {
    return { mode: 'run', prompt: text.replace(/^\/run\s*/, '').trim() };
  }
  if (last === '/plan') {
    return { mode: 'plan', prompt: lines.slice(0, -1).join('\n').trim() };
  }
  if (last === '/run') {
    return { mode: 'run', prompt: lines.slice(0, -1).join('\n').trim() };
  }
  // 預設：plan mode（較安全，不自動執行 edit）
  return { mode: 'plan', prompt: text.trim() };
}

/** Telegram 訊息上限 4096 字元，拆分長訊息 */
const TG_MAX_LEN = 4000;

function splitMessage(text: string): string[] {
  if (text.length <= TG_MAX_LEN) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TG_MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    // 在 TG_MAX_LEN 以內找最後一個換行切割
    let splitAt = remaining.lastIndexOf('\n', TG_MAX_LEN);
    if (splitAt <= 0) splitAt = TG_MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

/** 對話紀錄上限（user+assistant 各算一筆，過大會灌爆 context window） */
const MAX_HISTORY_MESSAGES = 15;

/** 將對話紀錄組成 context 前綴，讓 Claude 理解先前對話 */
function buildHistoryContext(messages: ChatMessage[]): string {
  if (messages.length === 0) return '';
  const lines = messages.map((m) => {
    const label = m.role === 'user' ? 'User' : 'Assistant';
    // 截斷過長的單則訊息，避免超出 context window
    const content = m.content.length > 1500 ? m.content.slice(0, 1500) + '\n...(truncated)' : m.content;
    return `${label}:\n${content}`;
  });
  return `Here is our previous conversation for context:\n\n${lines.join('\n\n---\n\n')}\n\n---\n\nNow respond to the following:\n\n`;
}

function shortDateTime(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const time = d.toTimeString().slice(0, 8);
  return `${mm}-${dd} ${time}`;
}

const FILE_SESSIONS = '.sessions.json';

/** 讀取 .sessions.json（file watcher 的 session mapping） */
function loadFileSessions(promptDir: string): Record<string, any> {
  try {
    const file = join(promptDir, FILE_SESSIONS);
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf-8'));
    }
  } catch {}
  return {};
}

/** 更新 .sessions.json 的特定 entry */
function updateFileSession(promptDir: string, filename: string, data: Partial<SessionData>): void {
  const sessions = loadFileSessions(promptDir);
  sessions[filename] = { ...sessions[filename], ...data };
  try {
    writeFileSync(join(promptDir, FILE_SESSIONS), JSON.stringify(sessions, null, 2));
  } catch {}
}

/** 取得 chat 對應的 .md 檔名（支援 /page 切換目標） */
function getMdFilename(chat: { id: number; type: string; title?: string }, sessionData?: SessionData): string {
  // 如果有指定 targetPage，用它
  if (sessionData?.targetPage) return sessionData.targetPage;
  // 預設：private → telegram.md, group → tg-{name}.md
  if (chat.type === 'private') return 'telegram.md';
  const name = (chat.title || String(chat.id)).replace(/[\/\\:*?"<>|]/g, '_');
  return `tg-${name}.md`;
}

// --- Session persistence ---

interface PersistedSessions {
  [chatId: string]: SessionData;
}

function loadSessions(filePath: string): Map<number, SessionData> {
  const map = new Map<number, SessionData>();
  try {
    if (existsSync(filePath)) {
      const data: PersistedSessions = JSON.parse(readFileSync(filePath, 'utf-8'));
      for (const [key, value] of Object.entries(data)) {
        map.set(Number(key), value);
      }
    }
  } catch {
    // 讀取失敗就用空的
  }
  return map;
}

function saveSessions(filePath: string, sessions: Map<number, SessionData>): void {
  const obj: PersistedSessions = {};
  for (const [chatId, data] of sessions) {
    obj[String(chatId)] = data;
  }
  try {
    writeFileSync(filePath, JSON.stringify(obj, null, 2));
  } catch {
    // 寫入失敗不影響運作
  }
}

export function startTelegramBot(cwd: string) {
  const token = process.env.BOT_TOKEN;
  if (!token) return null;

  const allowedUserId = Number(process.env.ALLOWED_USER_ID);
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

  // Ensure .penpage directory exists
  const promptDir = join(cwd, '.penpage');
  if (!existsSync(promptDir)) {
    mkdirSync(promptDir, { recursive: true });
  }

  const sessionsFile = join(promptDir, 'telegram-sessions.json');

  const bot = new Bot(token, {
    client: {
      baseFetchConfig: proxyUrl
        ? { agent: new HttpsProxyAgent(proxyUrl) as any, compress: true }
        : undefined,
    },
  });

  // Per-chat session data（從磁碟載入，每次更新後寫回）
  const chatSessions = loadSessions(sessionsFile);
  if (chatSessions.size > 0) {
    console.log(`  Sessions: 已載入 ${chatSessions.size} 個 chat session`);
  }

  // 併發保護：每個 chat 同時只能有一個 prompt 在執行
  const busyChats = new Set<number>();

  function getSession(chatId: number): SessionData {
    if (!chatSessions.has(chatId)) {
      chatSessions.set(chatId, {});
    }
    return chatSessions.get(chatId)!;
  }

  function persistSessions(): void {
    saveSessions(sessionsFile, chatSessions);
  }

  function isAuthorized(userId: number | undefined): boolean {
    if (!allowedUserId) return true;
    return userId === allowedUserId;
  }

  /** 執行一次 Claude Code prompt，回傳結果 */
  async function executePrompt(
    ctx: Context,
    prompt: string,
    mode: 'plan' | 'run',
    sessionData: SessionData,
    statusMsg: { chat: { id: number }; message_id: number },
    sessionId?: string,
  ): Promise<RunResult> {
    const runner = sessionData.runner || 'claude';
    const modelLabel = sessionData.model ? `${runner} - ${sessionData.model}` : runner;
    const isResuming = !!sessionId;
    const sessionTag = isResuming
      ? ` [${sessionId!.slice(0, 7)}]`
      : ' [new]';
    const turnInfo = sessionData.totalTurns
      ? ` | turn ${sessionData.totalTurns + 1}`
      : '';
    const modeLabel = mode === 'plan' ? 'Plan' : 'Auto';
    let lastProgressUpdate = Date.now();
    let receivedChars = 0;

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `🧠 ${modeLabel} mode (${modelLabel})${sessionTag}${turnInfo}\n⏳ Thinking...`,
    ).catch(() => {});

    const { child, done } = runPrompt(runner, prompt, cwd, {
      permissionMode: mode === 'plan' ? 'plan' : 'auto',
      sessionId,
      model: sessionData.model,
      addDirs: sessionData.addDirs,
    }, {
      onText: (text) => {
        receivedChars += text.length;
        const now = Date.now();
        if (now - lastProgressUpdate > 5000) {
          lastProgressUpdate = now;
          const chars = receivedChars > 1000
            ? `${(receivedChars / 1000).toFixed(1)}k`
            : `${receivedChars}`;
          ctx.api.editMessageText(
            statusMsg.chat.id,
            statusMsg.message_id,
            `🧠 ${modeLabel} mode (${modelLabel})${sessionTag}${turnInfo}\n⏳ Generating... (${chars} chars)`,
          ).catch(() => {});
        }
      },
    });

    // 10 分鐘 timeout，避免 Claude Code 卡住導致 chat 永久鎖定
    const TIMEOUT_MS = 10 * 60 * 1000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, TIMEOUT_MS);

    const result = await done;
    clearTimeout(timer);

    if (timedOut) {
      result.text += '\n\n(⏱️ 已超過 5 分鐘自動中斷)';
    }

    return result;
  }

  /** 送 prompt 到 Claude Code，回傳結果並更新 session */
  async function sendToClaude(
    ctx: Context,
    prompt: string,
    mode: 'plan' | 'run',
    sessionData: SessionData,
  ): Promise<void> {
    const chatId = ctx.chat!.id;

    // 併發保護
    if (busyChats.has(chatId)) {
      await ctx.reply('⏳ 上一個 prompt 還在執行中，請稍後再試。');
      return;
    }
    busyChats.add(chatId);

    const startTime = shortDateTime();
    const startMs = Date.now();

    // 送出「思考中」訊息，後續用 editMessageText 更新進度
    const mdFile = getMdFilename(ctx.chat!, sessionData);
    const statusMsg = await ctx.reply(`⏳ Thinking... → ${mdFile}`);

    // 如果目標是特定 page（非預設），載入該 page 的 file session（共用 sessionId）
    if (sessionData.targetPage) {
      const fileSessions = loadFileSessions(promptDir);
      const fileSession = fileSessions[sessionData.targetPage];
      if (fileSession?.sessionId && !sessionData.sessionId) {
        sessionData.sessionId = fileSession.sessionId;
      }
    }

    // 初始化對話紀錄
    if (!sessionData.messages) sessionData.messages = [];

    const cmdLabel = mode === 'plan' ? '/plan' : '/run';
    const botRunner = sessionData.runner || 'claude';
    const botModel = sessionData.model ? `${botRunner} - ${sessionData.model}` : botRunner;
    console.log(formatLogLine({
      source: 'bot', filename: mdFile, model: botModel, sessionId: sessionData.sessionId,
      chat: ctx.chat!, command: cmdLabel, promptPreview: prompt,
    }));

    let result: RunResult;
    let actualPrompt = prompt;
    try {
      result = await executePrompt(
        ctx, prompt, mode, sessionData, statusMsg, sessionData.sessionId,
      );

      // 如果有 session 但執行失敗（exit code 非 0 且無回應），嘗試不帶 resume 重試
      if (
        sessionData.sessionId &&
        result.exitCode !== 0 &&
        !result.text.trim() &&
        !result.session
      ) {
        const oldSid = sessionData.sessionId.slice(0, 7);
        const historyLen = sessionData.messages?.length || 0;
        console.log(`  ⚠️ Resume ${oldSid} failed, retrying with ${historyLen} messages history...`);
        await ctx.api.editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          `⚠️ Session ${oldSid} 已失效，以 ${historyLen} 則對話紀錄開啟新 session...`,
        ).catch(() => {});
        // 清除舊 session，用對話紀錄重建 context
        sessionData.sessionId = undefined;
        const historyContext = buildHistoryContext(sessionData.messages || []);
        actualPrompt = historyContext + prompt;
        result = await executePrompt(
          ctx, actualPrompt, mode, sessionData, statusMsg, undefined,
        );
      }
    } catch (err: any) {
      console.log(formatLogLine({
        source: 'bot', filename: mdFile, model: botModel, sessionId: sessionData.sessionId,
        chat: ctx.chat!, status: `err:${err.message}`,
      }));
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        `❌ ${err.message}`,
      ).catch(() => {});
      busyChats.delete(chatId);
      return;
    } finally {
      busyChats.delete(chatId);
    }

    // 更新 session data（保持同一 session）
    if (result.result?.sessionId) sessionData.sessionId = result.result.sessionId;
    else if (result.session?.id) sessionData.sessionId = result.session.id;
    if (result.result) {
      sessionData.totalCost = (sessionData.totalCost || 0) + (result.result.cost || 0);
      sessionData.totalTurns = (sessionData.totalTurns || 0) + (result.result.turns || 0);
      sessionData.totalInputTokens = (sessionData.totalInputTokens || 0) + result.result.inputTokens;
      sessionData.totalOutputTokens = (sessionData.totalOutputTokens || 0) + result.result.outputTokens;
    }

    // 儲存對話紀錄（user prompt + assistant response）
    const now = Date.now();
    sessionData.messages!.push({ role: 'user', content: prompt, timestamp: now });
    const assistantText = result.text.trim();
    if (assistantText) {
      sessionData.messages!.push({ role: 'assistant', content: assistantText, timestamp: now });
    }
    // 限制紀錄數量，保留最近 N 則
    if (sessionData.messages!.length > MAX_HISTORY_MESSAGES) {
      sessionData.messages = sessionData.messages!.slice(-MAX_HISTORY_MESSAGES);
    }

    // 持久化 session 到磁碟
    persistSessions();

    // 刪除「思考中」訊息
    await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id).catch(() => {});

    // 發送回應（自動拆分長訊息，嘗試 Markdown 格式化）
    const output = result.text.trim() || '(no response)';
    const chunks = splitMessage(output);
    for (const chunk of chunks) {
      // 嘗試 Markdown 格式（code blocks 會正確渲染），失敗則退回純文字
      try {
        await ctx.reply(chunk, { parse_mode: 'Markdown' });
      } catch {
        await ctx.reply(chunk);
      }
    }

    // 共用 session data
    const actualModel = result.session?.model || botModel;
    const botDurSec = Math.round((Date.now() - startMs) / 1000);
    const sessionLineData = {
      model: actualModel,
      session: sessionData.sessionId,
      turns: sessionData.totalTurns,
      runCost: result.result?.cost,
      totalCost: sessionData.totalCost,
      inputTokens: result.result?.inputTokens,
      outputTokens: result.result?.outputTokens,
      cacheRead: result.result?.cacheRead,
      cacheCreation: result.result?.cacheCreation,
      contextUsed: result.result?.contextUsed,
      contextWindow: result.result?.contextWindow,
      durationSec: botDurSec,
    };
    const info = formatSessionLine(sessionLineData);

    // 發送 cost summary（與 md 格式一致，只差沒日期時間）
    if (result.result) {
      let contextWarning = '';
      const r = result.result;
      if (r.contextUsed && r.contextWindow) {
        const pct = Math.round((r.contextUsed / r.contextWindow) * 100);
        if (pct > 85) {
          contextWarning = '\n⚠️ Context 即將滿載，自動壓縮中...';
        } else if (pct > 70) {
          contextWarning = '\n⚡ Context > 70%，自動壓縮中...';
        }
      }
      await ctx.reply(`✅${info}${contextWarning}`);
    }

    // 寫入 .penpage/*.md 完整對話紀錄（開始/結束分開 code block）
    const mdPath = join(promptDir, mdFile);
    const endTime = shortDateTime();
    const sid = sessionData.sessionId ? sessionData.sessionId.slice(0, 7) : '';
    const response = output || '*No response.*';
    const block = `\n${prompt}\n\n\`\`\`\n${startTime} ✳️${sid} ${cmdLabel}\n\`\`\`\n\n${response}\n\n\`\`\`\n${endTime} ✅${info}\n\`\`\`\n\n---\n`;
    try {
      appendFileSync(mdPath, block);
    } catch (writeErr: any) {
      console.error(`  ❌ Failed to write ${mdPath}: ${writeErr.message}`);
    }

    // ← log（統一格式）
    const finalModel = result.session?.model || botModel;
    const finalSid = sessionData.sessionId;
    console.log(formatLogLine({
      source: 'bot', filename: mdFile, model: finalModel, sessionId: finalSid,
      chat: ctx.chat!, status: 'ok',
      runCost: result.result?.cost, totalCost: sessionData.totalCost,
      turns: sessionData.totalTurns,
      inputTokens: result.result?.inputTokens, outputTokens: result.result?.outputTokens,
      contextUsed: result.result?.contextUsed, contextWindow: result.result?.contextWindow,
      durationSec: botDurSec,
    }));

    // Auto compact：context > 70% 時自動壓縮
    if (result.result && sessionData.sessionId) {
      const r = result.result;
      if (r.contextUsed && r.contextWindow) {
        const pct = (r.contextUsed / r.contextWindow) * 100;
        if (pct > 70) {
          console.log(`  🔄 Auto compact: ctx ${pct.toFixed(0)}% > 70%`);
          try {
            const compactResult = await compactSession(sessionData.sessionId, cwd);
            const cr = compactResult.result;
            const compactInfo = formatCompactInfo({
              beforeCtxUsed: r.contextUsed, beforeCtxWindow: r.contextWindow,
              beforeCacheRead: r.cacheRead, beforeInputTokens: r.inputTokens, beforeOutputTokens: r.outputTokens,
              afterCtxUsed: cr?.contextUsed, afterCtxWindow: cr?.contextWindow,
              afterCacheRead: cr?.cacheRead, afterInputTokens: cr?.inputTokens, afterOutputTokens: cr?.outputTokens,
            });
            await ctx.reply(`✅auto-compact ${compactInfo}`);
          } catch {
            console.log('  ⚠️ Auto compact failed');
          }
        }
      }
    }

    // 同步更新 .sessions.json（讓 file watcher / PenPage 看到）
    {
      updateFileSession(promptDir, mdFile, {
        sessionId: sessionData.sessionId,
        runner: sessionData.runner,
        model: sessionData.model,
        addDirs: sessionData.addDirs,
        totalCost: sessionData.totalCost,
        totalTurns: sessionData.totalTurns,
        totalInputTokens: sessionData.totalInputTokens,
        totalOutputTokens: sessionData.totalOutputTokens,
      });
    }
  }

  // Log middleware — 用統一格式記錄收到的訊息
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.from) {
      const text = ctx.message?.text || ctx.callbackQuery?.data || '';
      const mdFile = getMdFilename(ctx.chat as any, getSession(ctx.chat.id));
      const sd = chatSessions.get(ctx.chat.id);
      const runner = sd?.runner || 'claude';
      const model = sd?.model ? `${runner} - ${sd.model}` : runner;
      console.log(formatLogLine({
        source: 'bot', filename: mdFile, model, sessionId: sd?.sessionId,
        chat: ctx.chat as any, command: text.slice(0, 60),
      }));
    }
    await next();
  });

  // 統一處理所有文字訊息
  bot.on('message:text', async (ctx) => {
    if (!isAuthorized(ctx.from?.id)) return;
    const text = ctx.message.text;
    const chatId = ctx.chat.id;
    const sessionData = getSession(chatId);

    // 0. Handle /start（Telegram 特有指令，不送到 Claude Code）
    if (text === '/start' || text === '/start@' + bot.botInfo?.username) {
      const s = sessionData;
      const lines: string[] = ['🤖 PenPage Agent — Claude Code via Telegram\n'];
      lines.push(`📁 Project: ${cwd}`);
      if (s.sessionId) {
        const sid = s.sessionId.slice(0, 7);
        lines.push(`📌 Session: ${sid} (${s.totalTurns || 0} turns, $${(s.totalCost || 0).toFixed(4)})`);
        if (s.messages?.length) {
          lines.push(`💬 History: ${s.messages.length} messages`);
        }
      } else {
        lines.push('📌 No active session — 發送訊息即開始新 session');
      }
      lines.push('');
      lines.push('直接輸入文字 → Claude Code (plan mode)');
      lines.push('/run <prompt> → Claude Code (auto mode)');
      lines.push('/new → 開新 session');
      lines.push('/help → 所有指令');
      await ctx.reply(lines.join('\n'));
      return;
    }

    // 1. 嘗試 slash command（/model, /diag, /cost, /session, /clear 等）
    const parsed = parseCommand(text);
    if (parsed) {
      const result = await executeCommand(parsed.name, parsed.args, {
        cwd,
        filename: `telegram-${chatId}`,
        sessionData,
      });
      if (result) {
        // /compact → 送 '/compact' 給 CLI
        if (result.action === 'compact' && sessionData.sessionId) {
          await ctx.reply(result.markdown);
          try {
            await compactSession(sessionData.sessionId, cwd);
            await ctx.reply('✅ Context compacted.');
          } catch {
            await ctx.reply('❌ Compact failed.');
          }
          return;
        }
        await ctx.reply(result.markdown);
        if (result.sessionUpdate) {
          Object.assign(sessionData, result.sessionUpdate);
          persistSessions();
        }
        return;
      }
    }

    // 2. 所有文字都送到 Claude Code（含 /plan、/run prefix 或純文字）
    const { mode, prompt } = parseMode(text);
    if (!prompt) {
      await ctx.reply('請輸入訊息內容。');
      return;
    }

    await sendToClaude(ctx, prompt, mode, sessionData);
  });

  // 啟動
  bot.start({
    onStart: () => {
      console.log('  Telegram: Bot 已啟動');
      if (proxyUrl) console.log(`  Proxy:    ${proxyUrl}`);
      if (allowedUserId) {
        console.log(`  Auth:     僅回應 User ID ${allowedUserId}`);
      } else {
        console.log('  Auth:     未設定 ALLOWED_USER_ID，任何人都可操作');
      }
      console.log('  Mode:     直接輸入文字 → Claude Code (plan mode)');
      console.log('            /run <prompt> → Claude Code (auto mode)');
      console.log('  Session:  自動 resume 同一 session（跨訊息保持 context）');
      if (chatSessions.size > 0) {
        for (const [chatId, s] of chatSessions) {
          if (s.sessionId) {
            const turns = s.totalTurns || 0;
            const msgs = s.messages?.length || 0;
            console.log(`  Session:  chat ${chatId} → ${s.sessionId.slice(0, 7)} (${turns} turns, ${msgs} msgs, restored)`);
          }
        }
      }
    },
  });

  return bot;
}
