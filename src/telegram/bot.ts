import { Bot } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { exec } from 'child_process';

// 白名單命令（安全起見，只允許預定義命令）
const shellCommands: Record<string, string> = {
  '/ping': 'echo pong',
  '/uptime': 'uptime',
  '/df': 'df -h',
  '/who': 'whoami && hostname',
  '/ip': 'curl -s ifconfig.me',
  '/mem': 'top -l 1 -s 0 | head -n 10',
};

export function startTelegramBot() {
  const token = process.env.BOT_TOKEN;
  if (!token) return null;

  const allowedUserId = Number(process.env.ALLOWED_USER_ID);
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

  const bot = new Bot(token, {
    client: {
      baseFetchConfig: proxyUrl
        ? { agent: new HttpsProxyAgent(proxyUrl) as any, compress: true }
        : undefined,
    },
  });

  // 驗證發送者
  function isAuthorized(userId: number | undefined): boolean {
    if (!allowedUserId) return true;
    return userId === allowedUserId;
  }

  // 印出聊天與發送者資訊
  bot.use(async (ctx, next) => {
    const chat = ctx.chat;
    const from = ctx.from;
    if (chat && from) {
      const time = new Date().toLocaleTimeString();
      const text = ctx.message?.text || ctx.callbackQuery?.data || '';
      console.log(`--- [${time}] 收到訊息 ---`);
      console.log(`  Chat:`, JSON.stringify(chat, null, 4));
      console.log(`  From:`, JSON.stringify(from, null, 4));
      console.log(`  Text: ${text}`);
      console.log(`---`);
    }
    await next();
  });

  // /start
  bot.command('start', async (ctx) => {
    if (!isAuthorized(ctx.from?.id)) return;
    const cmdList = Object.keys(shellCommands).join('\n');
    await ctx.reply(`🤖 PenPage Agent Bot 就緒\n\n可用命令：\n${cmdList}\n\n直接輸入文字會 echo 回來（測試用）`);
  });

  // /help
  bot.command('help', async (ctx) => {
    if (!isAuthorized(ctx.from?.id)) return;
    const cmdList = Object.entries(shellCommands)
      .map(([cmd, shell]) => `${cmd} → ${shell}`)
      .join('\n');
    await ctx.reply(`命令對照表：\n${cmdList}\n\n你的 User ID: ${ctx.from?.id}`);
  });

  // 處理白名單 shell 命令
  for (const [cmd, shell] of Object.entries(shellCommands)) {
    const name = cmd.slice(1);
    bot.command(name, async (ctx) => {
      if (!isAuthorized(ctx.from?.id)) return;
      await ctx.reply(`⏳ 執行中...`);
      exec(shell, { timeout: 30000 }, async (err, stdout, stderr) => {
        const output = stdout || stderr || (err ? err.message : '(no output)');
        const truncated = output.length > 4000
          ? output.slice(0, 4000) + '\n... (truncated)'
          : output;
        await ctx.reply(truncated);
      });
    });
  }

  // 任意文字 → echo
  bot.on('message:text', async (ctx) => {
    if (!isAuthorized(ctx.from?.id)) return;
    await ctx.reply(`📨 收到: ${ctx.message.text}`);
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
    },
  });

  return bot;
}
