interface ToolInfo {
  name: string;
  displayName: string;
}

interface Config {
  cwd: string;
}

let selectedTool: string = '';
let isRunning = false;
let config: Config = { cwd: '' };

const messagesEl = document.getElementById('messages') as HTMLDivElement;
const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const toolSelectorEl = document.getElementById('tool-selector') as HTMLDivElement;

// Initialize
async function init() {
  // Load config
  const configRes = await fetch('/api/config');
  config = await configRes.json();

  // Load available tools
  const toolsRes = await fetch('/api/ai/tools');
  const { tools } = await toolsRes.json() as { tools: ToolInfo[] };

  if (tools.length === 0) {
    showEmptyState('No AI CLI tools found. Install claude, gemini, or codex CLI first.');
    return;
  }

  renderToolSelector(tools);
  selectedTool = tools[0].name;
  updateToolButtons();

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
  });
}

function updateToolButtons() {
  toolSelectorEl.querySelectorAll('.tool-btn').forEach((btn) => {
    const el = btn as HTMLElement;
    el.classList.toggle('active', el.dataset.tool === selectedTool);
  });
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
  // Clear empty state
  const empty = messagesEl.querySelector('.empty-state');
  if (empty) empty.remove();

  const msg = document.createElement('div');
  msg.className = `message ${role}`;
  msg.innerHTML = `<div class="label">${label}</div><div class="content"></div>`;
  messagesEl.appendChild(msg);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return msg;
}

async function runPrompt() {
  const prompt = promptInput.value.trim();
  if (!prompt || isRunning) return;

  isRunning = true;
  sendBtn.disabled = true;
  sendBtn.textContent = 'Running...';
  promptInput.value = '';

  // Show user message
  addMessage('user', 'You');
  const userContent = messagesEl.querySelector('.message.user:last-child .content') as HTMLDivElement;
  userContent.textContent = prompt;

  // Show AI message (streaming)
  const toolDisplay = selectedTool.charAt(0).toUpperCase() + selectedTool.slice(1);
  const aiMsg = addMessage('ai', toolDisplay);
  aiMsg.classList.add('streaming');
  const aiContent = aiMsg.querySelector('.content') as HTMLDivElement;

  try {
    const res = await fetch('/api/ai/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, tool: selectedTool, cwd: config.cwd }),
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
  // Cmd/Ctrl + Enter to send
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    runPrompt();
  }
});

// Auto-resize textarea
promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
});

init();
