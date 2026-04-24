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
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
}

let selectedTool: string = '';
let isRunning = false;
let config: Config = { cwd: '' };
let currentModel: string = '';
let permissionMode: 'auto' | 'plan' = 'plan';
const addedDirs: string[] = [];

const toolModels: Record<string, Array<{ value: string; label: string }>> = {
  claude: [
    { value: '', label: 'Default' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
    { value: 'haiku', label: 'Haiku' },
  ],
  gemini: [
    { value: '', label: 'Default' },
    { value: 'gemini-2.5-pro', label: '2.5 Pro' },
    { value: 'gemini-2.5-flash', label: '2.5 Flash' },
    { value: 'gemini-2.0-flash', label: '2.0 Flash' },
  ],
  codex: [
    { value: '', label: 'Default' },
    { value: 'o3', label: 'o3' },
    { value: 'o4-mini', label: 'o4-mini' },
    { value: 'codex-mini', label: 'codex-mini' },
  ],
};

// Session tracking per tool
const sessions: Record<string, SessionInfo> = {};
let availableTools: ToolInfo[] = [];

const messagesEl = document.getElementById('messages') as HTMLDivElement;
const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const sessionBarEl = document.getElementById('session-bar') as HTMLDivElement;
const modeToggleEl = document.getElementById('mode-toggle') as HTMLDivElement;
const menuDropdownBtn = document.getElementById('menu-dropdown-btn') as HTMLButtonElement;
const runMenu = document.getElementById('run-menu') as HTMLDivElement;

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

  availableTools = tools;
  selectedTool = tools[0].name;
  initRunMenu();
  initModeToggle();
  updateRunButton();
  updateSessionBar();

  showEmptyState(`Ready. Using ${tools[0].displayName} in ${config.cwd}`);
}

function initModeToggle() {
  modeToggleEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.mode-btn') as HTMLElement;
    if (!btn || isRunning) return;
    permissionMode = btn.dataset.mode as 'auto' | 'plan';
    modeToggleEl.querySelectorAll('.mode-btn').forEach((b) => {
      (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.mode === permissionMode);
    });
  });
}

function updateRunButton() {
  const toolLabel = availableTools.find((t) => t.name === selectedTool)?.displayName || selectedTool;
  const parts = [toolLabel];
  if (currentModel) parts.push(currentModel);
  sendBtn.textContent = parts.join(' · ');
}

function renderRunMenu() {
  let html = '';

  for (const t of availableTools) {
    const models = toolModels[t.name] || [{ value: '', label: 'Default' }];
    const toolShort = t.name.charAt(0).toUpperCase() + t.name.slice(1);
    for (const m of models) {
      const active = t.name === selectedTool && m.value === currentModel ? ' active' : '';
      const label = m.value ? `${toolShort} - ${m.label}` : toolShort;
      html += `<div class="run-menu-item${active}" data-tool="${t.name}" data-model="${m.value}">${label}</div>`;
    }
  }

  runMenu.innerHTML = html;
}

function initRunMenu() {
  menuDropdownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    renderRunMenu();
    runMenu.classList.toggle('hidden');
  });

  runMenu.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('.run-menu-item') as HTMLElement;
    if (!item) return;

    const newTool = item.dataset.tool || '';
    const newModel = item.dataset.model || '';

    if (newTool !== selectedTool) {
      selectedTool = newTool;
      updateSessionBar();
    }
    currentModel = newModel;

    updateRunButton();
    runMenu.classList.add('hidden');
  });

  // Close menu on outside click
  document.addEventListener('click', () => {
    runMenu.classList.add('hidden');
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
      const fillColor = pct > 80 ? '#ef5350' : pct > 60 ? '#ffb74d' : '#ffd54f';
      contextHtml = `
        <span class="session-context">
          <span class="context-bar" style="background: linear-gradient(to right, ${fillColor} ${pct}%, rgba(255,255,255,0.1) ${pct}%)"></span>
          ${pct}% ${usedK}k/${totalK}k
        </span>
      `;
    }

    // Token breakdown
    let tokenHtml = '';
    if (session.inputTokens > 0 || session.outputTokens > 0) {
      const inK = (session.inputTokens / 1000).toFixed(1);
      const outK = (session.outputTokens / 1000).toFixed(1);
      const parts = [`in:${inK}k`, `out:${outK}k`];
      if (session.cacheRead > 0) parts.push(`cache:${(session.cacheRead / 1000).toFixed(1)}k`);
      tokenHtml = `<span class="session-tokens">${parts.join(' ')}</span>`;
    }

    sessionBarEl.innerHTML = `
      <span class="session-id" title="${session.id}">${session.id.slice(0, 8)}</span>
      <span class="session-model">${session.model || ''}</span>
      <span class="session-turns">${session.turns} turn${session.turns !== 1 ? 's' : ''}</span>
      ${costStr ? `<span class="session-cost">${costStr}</span>` : ''}
      ${tokenHtml}
      ${contextHtml}
    `;
    sessionBarEl.style.display = 'flex';
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

function mdToHtml(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

async function handleCommand(input: string): Promise<boolean> {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // Client-only commands
  switch (cmd) {
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

    case '/compact': {
      const session = sessions[selectedTool];
      if (!session) {
        addSystemMessage('No active session to compact.');
      } else {
        compactSession();
      }
      return true;
    }
  }

  // Shared commands via server API
  try {
    const res = await fetch('/api/ai/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input,
        cwd: config.cwd,
        sessionData: {
          sessionId: sessions[selectedTool]?.id,
          model: currentModel || undefined,
          addDirs: addedDirs.length ? addedDirs : undefined,
        },
      }),
    });
    const data = await res.json() as {
      handled: boolean;
      markdown?: string;
      sessionUpdate?: { sessionId?: string; model?: string; addDirs?: string[] };
      sessionList?: Array<{ sessionId: string; name: string; startedAt: number }>;
    };

    if (!data.handled) return false;

    // Apply session state updates
    if (data.sessionUpdate) {
      if ('model' in data.sessionUpdate) {
        currentModel = data.sessionUpdate.model || '';
        updateRunButton();
      }
      if ('addDirs' in data.sessionUpdate) {
        addedDirs.length = 0;
        if (data.sessionUpdate.addDirs) {
          addedDirs.push(...data.sessionUpdate.addDirs);
        }
      }
      if ('sessionId' in data.sessionUpdate) {
        if (data.sessionUpdate.sessionId) {
          resumeSession(data.sessionUpdate.sessionId);
          return true;
        }
      }
    }

    // Handle /clear — also clear client-side state
    if (cmd === '/clear') {
      delete sessions[selectedTool];
      messagesEl.innerHTML = '';
      updateSessionBar();
      showEmptyState(`New session. Using ${selectedTool} in ${config.cwd}`);
      return true;
    }

    // Handle /sessions — render clickable list
    if (data.sessionList && data.sessionList.length > 0) {
      const rows = data.sessionList.map((s, i) => {
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

      addSystemMessage(`<b>Recent sessions</b> (click to resume):<br>${rows}`);

      // Add click handlers
      const items = messagesEl.querySelectorAll('.session-item');
      items.forEach((item) => {
        (item as HTMLElement).style.cursor = 'pointer';
        item.addEventListener('click', () => {
          const id = (item as HTMLElement).dataset.sessionId!;
          previewSession(id);
        });
      });
      return true;
    }

    // Default: render markdown as HTML
    if (data.markdown) {
      addSystemMessage(mdToHtml(data.markdown));
    }
    return true;
  } catch {
    return false;
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
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreation: 0,
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
      session.inputTokens = data.usage.inputTokens;
      session.outputTokens = data.usage.outputTokens;
      session.cacheRead = data.usage.cacheRead;
      session.cacheCreation = data.usage.cacheCreation;
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
    }
  } catch {
    updateSessionBar();
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
    if (await handleCommand(prompt)) return;
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
        permissionMode: selectedTool === 'claude' ? permissionMode : undefined,
        addDirs: addedDirs.length > 0 ? addedDirs : undefined,
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
                inputTokens: 0,
                outputTokens: 0,
                cacheRead: 0,
                cacheCreation: 0,
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
              session.inputTokens = data.result.inputTokens || 0;
              session.outputTokens = data.result.outputTokens || 0;
              session.cacheRead = data.result.cacheRead || 0;
              session.cacheCreation = data.result.cacheCreation || 0;
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
    updateRunButton();
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
