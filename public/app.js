const conversation = document.querySelector('#conversation');
const welcome = document.querySelector('#welcome');
const input = document.querySelector('#messageInput');
const sendButton = document.querySelector('#sendButton');
const newChatButton = document.querySelector('#newChatButton');
const clearButton = document.querySelector('#clearButton');
const attachButton = document.querySelector('#attachButton');
const fileInput = document.querySelector('#fileInput');
const attachmentName = document.querySelector('#attachmentName');
const authScreen = document.querySelector('#authScreen');
const authForm = document.querySelector('#authForm');
const authName = document.querySelector('#authName');
const authEmail = document.querySelector('#authEmail');
const authPassword = document.querySelector('#authPassword');
const authTitle = document.querySelector('#authTitle');
const authSubmit = document.querySelector('#authSubmit');
const authSwitch = document.querySelector('#authSwitch');
const authError = document.querySelector('#authError');
const profileName = document.querySelector('#profileName');
const profileButton = document.querySelector('#profileButton');

let messages = [];
let isWaiting = false;
let pendingFile = null;
let editingIndex = null;
let authMode = 'register';

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);
}

function renderMarkdown(value) {
  const escaped = escapeHtml(value);
  const blocks = escaped.split(/```([\s\S]*?)```/g);
  return blocks.map((block, index) => {
    if (index % 2 === 1) return `<pre><code>${block.trim()}</code></pre>`;
    const lines = block.split('\n');
    const tableLines = lines.filter((line) => /^\s*\|.*\|\s*$/.test(line));
    let html = block.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>').replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    if (tableLines.length >= 2) {
      const rows = tableLines.filter((line) => !/^\s*\|?\s*:?-{3,}/.test(line));
      const table = rows.map((row, rowIndex) => {
        const cells = row.split('|').slice(1, -1).map((cell) => `<${rowIndex === 0 ? 'th' : 'td'}>${cell.trim()}</${rowIndex === 0 ? 'th' : 'td'}>`).join('');
        return `<tr>${cells}</tr>`;
      }).join('');
      html = html.replace(tableLines.join('\n'), `<table>${table}</table>`);
    }
    return html.replace(/\n/g, '<br>');
  }).join('');
}

function scrollToBottom() {
  conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' });
}

function addMessage(role, content, attachment = null, messageIndex = null, downloadUrl = null) {
  welcome?.remove();
  const message = document.createElement('article');
  message.className = `message ${role}`;
  message.innerHTML = `
    <div class="message-avatar ${role === 'assistant' ? 'icon-spark' : 'icon-user'}" aria-hidden="true"></div>
    <div>
      <div class="message-label">${role === 'assistant' ? 'Engibot' : 'You'}</div>
      <div class="message-body">${role === 'assistant' ? renderMarkdown(content) : escapeHtml(content).replace(/\n/g, '<br>')}</div>
      ${role === 'user' && messageIndex !== null ? '<button class="edit-message" type="button">Edit</button>' : ''}
    </div>`;
  if (attachment) {
    const image = document.createElement('img');
    image.className = 'message-image';
    image.src = attachment.dataUrl;
    image.alt = attachment.name;
    message.querySelector('.message-body').prepend(image);
  }
  if (role === 'user' && messageIndex !== null) {
    message.querySelector('.edit-message').addEventListener('click', () => editMessage(message, messageIndex, content));
  }
  if (downloadUrl) {
    const download = document.createElement('a');
    download.className = 'download-document';
    download.href = downloadUrl;
    download.download = '';
    download.textContent = 'Download Word document';
    message.querySelector('.message-body').append(download);
  }
  conversation.append(message);
  scrollToBottom();
}

function showTyping() {
  const typing = document.createElement('article');
  typing.className = 'message';
  typing.id = 'typingMessage';
  typing.innerHTML = '<div class="message-avatar icon-spark" aria-hidden="true"></div><div><div class="message-label">Engibot</div><div class="typing"><i></i><i></i><i></i></div></div>';
  conversation.append(typing);
  scrollToBottom();
}

function setWaiting(value) {
  isWaiting = value;
  sendButton.disabled = value;
  input.disabled = value;
  attachButton.disabled = value;
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  authTitle.textContent = registering ? 'Create your account' : 'Log in to Engibot';
  authSubmit.textContent = registering ? 'Create account' : 'Log in';
  authSwitch.textContent = registering ? 'Already have an account? Log in' : 'Need an account? Create one';
  document.querySelector('#nameField').hidden = !registering;
  authName.required = registering;
  authError.textContent = '';
}

function showAuthenticated(user) {
  authScreen.hidden = true;
  profileName.textContent = user.name;
  profileButton.title = `${user.name} (${user.email})`;
}

async function checkSession() {
  try {
    const response = await fetch('/api/auth/me');
    if (response.ok) showAuthenticated((await response.json()).user);
    else authScreen.hidden = false;
  } catch {
    authScreen.hidden = false;
  }
}

function editMessage(messageElement, messageIndex, content) {
  editingIndex = messageIndex;
  input.value = content;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  input.focus();
  attachmentName.textContent = 'Editing this message. Press Enter to regenerate.';
  messageElement.classList.add('editing');
}

async function sendMessage(rawMessage = input.value) {
  const content = rawMessage.trim();
  if ((!content && !pendingFile) || isWaiting) return;

  const sentFile = pendingFile;
  const messageContent = content || 'Please inspect this file and tell me what it contains.';

  if (editingIndex !== null) {
    messages.splice(editingIndex);
    const editedElement = conversation.querySelector('.message.editing');
    if (editedElement) {
      let current = editedElement;
      while (current) {
        const next = current.nextElementSibling;
        current.remove();
        current = next;
      }
    }
    editingIndex = null;
  }

  input.value = '';
  input.style.height = 'auto';
  pendingFile = null;
  attachmentName.textContent = '';
  messages.push({ role: 'user', content: messageContent });
  addMessage('user', content || 'Please inspect this file.', sentFile?.isImage ? sentFile : null, messages.length - 1);
  showTyping();
  setWaiting(true);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, file: sentFile ? { name: sentFile.name, mimeType: sentFile.mimeType, data: sentFile.base64 } : undefined })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The request failed.');
    messages.push({ role: 'assistant', content: result.message });
    document.querySelector('#typingMessage')?.remove();
    addMessage('assistant', result.message, null, null, result.downloadUrl);
    if (result.documentError) addMessage('assistant', result.documentError);
  } catch (error) {
    document.querySelector('#typingMessage')?.remove();
    addMessage('assistant', `I couldn't complete that request. ${error.message}`);
  } finally {
    setWaiting(false);
    input.focus();
  }
}

function clearConversation() {
  messages = [];
  conversation.innerHTML = '';
  conversation.append(welcomeTemplate());
  bindPromptCards();
  input.value = '';
  pendingFile = null;
  editingIndex = null;
  attachmentName.textContent = '';
  fileInput.value = '';
  input.focus();
}

function welcomeTemplate() {
  const element = document.createElement('div');
  element.className = 'welcome';
  element.id = 'welcome';
  element.innerHTML = `<div class="welcome-orb icon-spark" aria-hidden="true"></div><p class="eyebrow">A clear space to think</p><h1>What are we<br><em>making</em> today?</h1><p class="welcome-copy">Ask a question, explore an idea, or bring a messy problem. I’m here to help you shape it.</p><div class="prompt-grid"><button class="prompt-card" data-prompt="Help me turn a rough idea into a clear plan."><span class="card-icon icon-arrow" aria-hidden="true"></span><strong>Shape an idea</strong><small>Turn a rough thought into a plan</small></button><button class="prompt-card" data-prompt="Explain this concept to me simply, with a useful example."><span class="card-icon icon-ring" aria-hidden="true"></span><strong>Learn something</strong><small>Get a clear, useful explanation</small></button><button class="prompt-card" data-prompt="Help me write a concise, thoughtful message about this: "><span class="card-icon icon-wave" aria-hidden="true"></span><strong>Find the words</strong><small>Write with more clarity and care</small></button></div>`;
  return element;
}

function bindPromptCards() {
  document.querySelectorAll('.prompt-card').forEach((card) => {
    card.addEventListener('click', () => {
      input.value = card.dataset.prompt;
      input.focus();
      input.dispatchEvent(new Event('input'));
    });
  });
}

sendButton.addEventListener('click', () => sendMessage());
newChatButton.addEventListener('click', clearConversation);
clearButton.addEventListener('click', clearConversation);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
});

attachButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  if (file.size > 18_000_000) {
    attachmentName.textContent = 'File is too large. Choose one under 18 MB.';
    fileInput.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingFile = { name: file.name, mimeType: file.type || 'application/octet-stream', base64: String(reader.result).split(',')[1], dataUrl: reader.result, isImage: file.type.startsWith('image/') };
    attachmentName.textContent = `Attached: ${file.name}`;
  };
  reader.readAsDataURL(file);
});

profileButton.addEventListener('click', () => {
  authScreen.hidden = false;
  setAuthMode('login');
});
authSwitch.addEventListener('click', () => setAuthMode(authMode === 'register' ? 'login' : 'register'));
authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  authError.textContent = '';
  authSubmit.disabled = true;
  const payload = { email: authEmail.value, password: authPassword.value };
  if (authMode === 'register') payload.name = authName.value;
  try {
    const response = await fetch(`/api/auth/${authMode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Authentication failed.');
    authForm.reset();
    showAuthenticated(result.user);
  } catch (error) {
    authError.textContent = error.message;
  } finally {
    authSubmit.disabled = false;
  }
});

bindPromptCards();
setAuthMode('register');
checkSession();
