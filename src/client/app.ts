interface ToolInfo {
  name: string;
  displayName: string;
}

interface Config {
  cwd: string;
}

interface SessionInfo {
  id: string;
  model: string;
  cwd: string;
  totalCost: number;
  turns: number;
  contextWindow: number;
  contextUsed: number;
}

let selectedTool: string = '';
let isRunning = false;
let config: Config = { cwd: '' };
let currentModel: string = '';

// Session tracking per tool
const sessions: Record<string, SessionInfo> = {};

const messagesEl = document.getElementById('messages') as HTMLDivElement;
const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const toolSelectorEl = document.getElementById('tool-selector') as HTMLDivElement;
const sessionBarEl = document.getElementById('session-bar') as HTMLDivElement;

// Initialize
async function init() {
  const configRes = await fetch('/api/config');
  config = await configRes.json();

  const toolsRes = await fetch('/api/ai/tools');
  const { tools } = await toolsRes.json() as { tools: ToolInfo[] };

  if (tools.length === 0) {
    showEmptyState('No AI CLI tools found. Install claude, gemini, or codex CLI first.');
    return;
  }

  renderToolSelector(tools);
  selectedTool = tools[0].name;
  updateToolButtons();
  updateSessionBar();

  showEmptyState(`Ready. Using ${tools[0].displayName} in ${config.cwd}`);
}

function renderToolSelector(tools: ToolInfo[]) {
  toolSelectorEl.innerHTML = tools
    .map(
      (t) =>
        `<button class="tool-btn" data-tool="${t.name}">${t.displayName}</button>`
    )
    .join('');

  toolSelectorEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.tool-btn') as HTMLElement;
    if (!btn || isRunning) return;
    selectedTool = btn.dataset.tool!;
    updateToolButtons();
    updateSessionBar();
  });
}

function updateToolButtons() {
  toolSelectorEl.querySelectorAll('.tool-btn').forEach((btn) => {
    const el = btn as HTMLElement;
    el.classList.toggle('active', el.dataset.tool === selectedTool);
  });
}

function updateSessionBar() {
  const session = sessions[selectedTool];
  if (session) {
    const costStr = session.totalCost > 0 ? `$${session.totalCost.toFixed(4)}` : '';

    // Context usage
    let contextHtml = '';
    if (session.contextWindow > 0 && session.contextUsed > 0) {
      const pct = Math.min(100, Math.round((session.contextUsed / session.contextWindow) * 100));
      const fillClass = pct > 80 ? 'danger' : pct > 60 ? 'warn' : '';
      const usedK = Math.round(session.contextUsed / 1000);
      const totalK = Math.round(session.contextWindow / 1000);
      contextHtml = `
        <span class="session-context">
          <span class="context-bar"><span class="context-bar-fill ${fillClass}" style="width: ${pct}%"></span></span>
          ${pct}% ${usedK}k/${totalK}k
        </span>
      `;
    }

    sessionBarEl.innerHTML = `
      <span class="session-id" title="${session.id}">${session.id.slice(0, 8)}</span>
      <span class="session-model">${session.model || ''}</span>
      <span class="session-turns">${session.turns} turn${session.turns !== 1 ? 's' : ''}</span>
      ${costStr ? `<span class="session-cost">${costStr}</span>` : ''}
      ${contextHtml}
      <button class="session-new-btn" title="Start new session">New</button>
    `;
    sessionBarEl.style.display = 'flex';

    const newBtn = sessionBarEl.querySelector('.session-new-btn') as HTMLButtonElement;
    newBtn.addEventListener('click', () => {
      delete sessions[selectedTool];
      messagesEl.innerHTML = '';
      updateSessionBar();
      showEmptyState(`New session. Using ${selectedTool} in ${config.cwd}`);
    });
  } else {
    sessionBarEl.innerHTML = `<span class="session-none">New session — /help for commands</span>`;
    sessionBarEl.style.display = 'flex';
  }
}

function showEmptyState(message: string) {
  messagesEl.innerHTML = `
    <div class="empty-state">
      <h2>PenPage Agent</h2>
      <p>${message}</p>
    </div>
  `;
}

function addMessage(role: 'user' | 'ai', label: string): HTMLDivElement {
  const empty = messagesEl.querySelector('.empty-state');
  if (empty) empty.remove();

  const msg = document.createElement('div');
  msg.className = `message ${role}`;
  msg.innerHTML = `<div class="label">${label}</div><div class="content"></div>`;
  messagesEl.appendChild(msg);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return msg;
}

function addSystemMessage(text: string) {
  const empty = messagesEl.querySelector('.empty-state');
  if (empty) empty.remove();

  const msg = document.createElement('div');
  msg.className = 'message system';
  msg.innerHTML = `<div class="content">${text}</div>`;
  messagesEl.appendChild(msg);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function handleCommand(input: string): boolean {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case '/clear': {
      delete sessions[selectedTool];
      messagesEl.innerHTML = '';
      updateSessionBar();
      showEmptyState(`New session. Using ${selectedTool} in ${config.cwd}`);
      return true;
    }

    case '/cost': {
      const session = sessions[selectedTool];
      if (session) {
        addSystemMessage(
          `<b>Session:</b> ${session.id}<br>` +
          `<b>Model:</b> ${session.model}<br>` +
          `<b>Turns:</b> ${session.turns}<br>` +
          `<b>Cost:</b> $${session.totalCost.toFixed(4)}`
        );
      } else {
        addSystemMessage('No active session.');
      }
      return true;
    }

    case '/model': {
      const modelName = parts[1];
      if (!modelName) {
        const session = sessions[selectedTool];
        addSystemMessage(
          `Current model: ${session?.model || 'default'}<br>` +
          `Usage: <code>/model &lt;name&gt;</code><br>` +
          `Examples: <code>/model sonnet</code>, <code>/model opus</code>, <code>/model haiku</code>`
        );
      } else {
        currentModel = modelName;
        addSystemMessage(`Model set to <b>${modelName}</b> for next prompt.`);
      }
      return true;
    }

    case '/compact': {
      const session = sessions[selectedTool];
      if (!session) {
        addSystemMessage('No active session to compact.');
      } else {
        // Send compact as a special prompt
        compactSession();
      }
      return true;
    }

    case '/sessions': {
      loadSessions();
      return true;
    }

    case '/resume': {
      const id = parts[1];
      if (id) {
        resumeSession(id);
      } else {
        loadSessions();
      }
      return true;
    }

    case '/help': {
      addSystemMessage(
        `<b>Commands:</b><br>` +
        `<code>/clear</code> — Clear chat and start new session<br>` +
        `<code>/cost</code> — Show session cost and usage<br>` +
        `<code>/model [name]</code> — Show or change model (sonnet, opus, haiku)<br>` +
        `<code>/compact</code> — Compact conversation context<br>` +
        `<code>/sessions</code> — List recent sessions<br>` +
        `<code>/resume [id]</code> — Resume a session (or pick from list)<br>` +
        `<code>/help</code> — Show this help`
      );
      return true;
    }

    default:
      return false;
  }
}

async function loadSessions() {
  try {
    const res = await fetch(`/api/ai/sessions?cwd=${encodeURIComponent(config.cwd)}`);
    const { sessions: list } = await res.json() as {
      sessions: Array<{
        sessionId: string;
        name: string;
        cwd: string;
        startedAt: number;
      }>;
    };

    if (list.length === 0) {
      addSystemMessage('No recent sessions found.');
      return;
    }

    const rows = list.map((s, i) => {
      const date = new Date(s.startedAt);
      const timeStr = date.toLocaleString();
      const shortId = s.sessionId.slice(0, 8);
      return `<div class="session-item" data-session-id="${s.sessionId}">` +
        `<span class="session-item-index">${i + 1}.</span> ` +
        `<span class="session-item-name">${s.name || 'unnamed'}</span> ` +
        `<span class="session-item-id">${shortId}</span> ` +
        `<span class="session-item-time">${timeStr}</span>` +
        `</div>`;
    }).join('');

    addSystemMessage(
      `<b>Recent sessions</b> (click to resume):<br>${rows}`
    );

    // Add click handlers — show preview first
    const items = messagesEl.querySelectorAll('.session-item');
    items.forEach((item) => {
      (item as HTMLElement).style.cursor = 'pointer';
      item.addEventListener('click', () => {
        const id = (item as HTMLElement).dataset.sessionId!;
        previewSession(id);
      });
    });
  } catch {
    addSystemMessage('Failed to load sessions.');
  }
}

async function previewSession(sessionId: string) {
  try {
    const res = await fetch(
      `/api/ai/sessions/${sessionId}/preview?cwd=${encodeURIComponent(config.cwd)}`
    );
    const { exchanges } = await res.json() as {
      exchanges: Array<{ role: string; text: string }>;
    };

    const shortId = sessionId.slice(0, 8);
    let html = `<b>Session ${shortId}... — Last exchanges:</b><br>`;

    if (exchanges.length === 0) {
      html += '<i>No text exchanges found.</i><br>';
    } else {
      html += '<div class="session-preview">';
      for (const ex of exchanges) {
        const label = ex.role === 'user' ? 'YOU' : 'AI';
        const cls = ex.role === 'user' ? 'preview-user' : 'preview-ai';
        const text = ex.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const truncated = text.length >= 300 ? text + '...' : text;
        html += `<div class="preview-exchange ${cls}"><span class="preview-label">${label}</span> ${truncated}</div>`;
      }
      html += '</div>';
    }

    html += `<br><button class="session-resume-btn" data-session-id="${sessionId}">Resume this session</button>`;

    addSystemMessage(html);

    // Add resume button handler
    const btn = messagesEl.querySelector(`.session-resume-btn[data-session-id="${sessionId}"]`);
    btn?.addEventListener('click', () => resumeSession(sessionId));
  } catch {
    addSystemMessage('Failed to load session preview.');
  }
}

async function resumeSession(sessionId: string) {
  sessions[selectedTool] = {
    id: sessionId,
    model: '',
    cwd: config.cwd,
    totalCost: 0,
    turns: 0,
    contextWindow: 0,
    contextUsed: 0,
  };
  messagesEl.innerHTML = '';

  // Load recent exchanges and usage
  try {
    const res = await fetch(
      `/api/ai/sessions/${sessionId}/preview?cwd=${encodeURIComponent(config.cwd)}`
    );
    const data = await res.json() as {
      exchanges: Array<{ role: string; text: string }>;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheRead: number;
        cacheCreation: number;
        contextUsed: number;
      };
      turns?: number;
      totalCost?: number;
    };

    // Update session with historical usage
    const session = sessions[selectedTool];
    if (data.usage) {
      session.contextUsed = data.usage.contextUsed;
    }
    if (data.turns) {
      session.turns = data.turns;
    }
    if (data.totalCost) {
      session.totalCost = data.totalCost;
    }

    updateSessionBar();

    if (data.exchanges.length > 0) {
      for (const ex of data.exchanges) {
        if (ex.role === 'user') {
          const msg = addMessage('user', 'You');
          const content = msg.querySelector('.content') as HTMLDivElement;
          content.textContent = ex.text;
        } else {
          const toolDisplay = selectedTool.charAt(0).toUpperCase() + selectedTool.slice(1);
          const msg = addMessage('ai', toolDisplay);
          msg.classList.add('history');
          const content = msg.querySelector('.content') as HTMLDivElement;
          content.textContent = ex.text;
        }
      }
      const usageInfo = data.usage ? `, ${Math.round(data.usage.contextUsed / 1000)}k tokens` : '';
      addSystemMessage(`Resumed session ${sessionId.slice(0, 8)}... — ${data.turns || 0} turns${usageInfo}`);
    } else {
      addSystemMessage(`Resumed session ${sessionId.slice(0, 8)}...`);
    }
  } catch {
    updateSessionBar();
    addSystemMessage(`Resumed session ${sessionId.slice(0, 8)}...`);
  }
}

async function compactSession() {
  if (selectedTool !== 'claude') {
    addSystemMessage('Compact is only supported for Claude.');
    return;
  }
  const session = sessions[selectedTool];
  if (!session) return;

  isRunning = true;
  sendBtn.disabled = true;
  addSystemMessage('Compacting conversation context...');

  try {
    const res = await fetch('/api/ai/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '/compact',
        tool: selectedTool,
        cwd: config.cwd,
        sessionId: session.id,
      }),
    });

    if (res.ok) {
      const reader = res.body!.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      addSystemMessage('Context compacted.');
    } else {
      addSystemMessage('Compact failed.');
    }
  } catch {
    addSystemMessage('Compact failed.');
  } finally {
    isRunning = false;
    sendBtn.disabled = false;
  }
}

async function runPrompt() {
  const prompt = promptInput.value.trim();
  if (!prompt || isRunning) return;

  // Check for slash commands
  if (prompt.startsWith('/')) {
    promptInput.value = '';
    promptInput.style.height = 'auto';
    if (handleCommand(prompt)) return;
    // Unknown command, send as regular prompt
  }

  isRunning = true;
  sendBtn.disabled = true;
  sendBtn.textContent = 'Running...';
  promptInput.value = '';
  promptInput.style.height = 'auto';

  // Show user message
  addMessage('user', 'You');
  const userContent = messagesEl.querySelector('.message.user:last-child .content') as HTMLDivElement;
  userContent.textContent = prompt;

  // Show AI message (streaming)
  const toolDisplay = selectedTool.charAt(0).toUpperCase() + selectedTool.slice(1);
  const aiMsg = addMessage('ai', toolDisplay);
  aiMsg.classList.add('streaming');
  const aiContent = aiMsg.querySelector('.content') as HTMLDivElement;

  // Get existing session ID for this tool
  const currentSession = sessions[selectedTool];

  try {
    const res = await fetch('/api/ai/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        tool: selectedTool,
        cwd: config.cwd,
        sessionId: currentSession?.id,
        model: currentModel || undefined,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      aiContent.textContent = `Error: ${err.error}`;
      aiMsg.classList.add('error');
      return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));

          // Session init info (Claude)
          if (data.session) {
            if (!sessions[selectedTool]) {
              sessions[selectedTool] = {
                id: data.session.id,
                model: data.session.model,
                cwd: data.session.cwd,
                totalCost: 0,
                turns: 0,
                contextWindow: data.session.contextWindow || 0,
                contextUsed: 0,
              };
            } else {
              sessions[selectedTool].model = data.session.model || sessions[selectedTool].model;
              if (data.session.contextWindow) {
                sessions[selectedTool].contextWindow = data.session.contextWindow;
              }
            }
            updateSessionBar();
            continue;
          }

          // Result info (Claude)
          if (data.result) {
            const session = sessions[selectedTool];
            if (session) {
              session.totalCost += data.result.cost || 0;
              session.turns += data.result.turns || 1;
              if (data.result.contextUsed) {
                session.contextUsed = data.result.contextUsed;
              }
              if (data.result.contextWindow) {
                session.contextWindow = data.result.contextWindow;
              }
            }
            updateSessionBar();
            continue;
          }

          if (data.done) continue;
          if (data.error) {
            aiContent.textContent += data.error;
          } else if (data.text) {
            aiContent.textContent += data.text;
          }
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } catch {
          // Skip malformed JSON
        }
      }
    }
  } catch (err) {
    aiContent.textContent = `Connection error: ${err}`;
    aiMsg.classList.add('error');
  } finally {
    aiMsg.classList.remove('streaming');
    isRunning = false;
    sendBtn.disabled = false;
    sendBtn.textContent = 'Run';
  }
}

// Event listeners
sendBtn.addEventListener('click', runPrompt);

promptInput.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    runPrompt();
  }
});

promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
});

init();
