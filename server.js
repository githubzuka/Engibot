import http from 'node:http';
import { readFile, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const downloadsDir = join(root, 'downloads');
const port = Number(process.env.PORT) || 3000;

try {
  const envFile = readFileSync(join(root, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch {
  // Environment variables can also be provided by the shell or hosting platform.
}

const apiKey = process.env.GROQ_API_KEY;
const execFileAsync = promisify(execFile);
const scrypt = promisify(scryptCallback);
const pythonCommand = process.env.PYTHON_COMMAND || 'python';
const mongoUri = process.env.MONGODB_URI;
const authSecret = process.env.AUTH_SECRET || randomBytes(32).toString('hex');
let mongoClient;
let users;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function getUsers() {
  if (!mongoUri || mongoUri.includes('<db_password>')) throw new Error('MONGODB_URI is not configured. Add your MongoDB connection string to .env.');
  if (!users) {
    mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();
    users = mongoClient.db('engibot').collection('users');
    await users.createIndex({ email: 1 }, { unique: true });
  }
  return users;
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${Buffer.from(hash).toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [salt, savedHash] = stored.split(':');
  const hash = await scrypt(password, salt, 64);
  const expected = Buffer.from(savedHash, 'hex');
  return expected.length === hash.length && timingSafeEqual(expected, hash);
}

function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({ id: user._id.toString(), exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const signature = createHmac('sha256', authSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function getUserId(request) {
  const token = request.headers.cookie?.match(/(?:^|;\s*)engibot_session=([^;]+)/)?.[1];
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', authSecret).update(payload).digest('base64url');
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data.id : null;
  } catch {
    return null;
  }
}

function setSession(response, user) {
  response.setHeader('Set-Cookie', `engibot_session=${makeToken(user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
}

async function handleAuth(request, response) {
  let payload;
  try { payload = await readBody(request); } catch { return sendJson(response, 400, { error: 'Please send valid JSON.' }); }
  const email = String(payload.email || '').trim().toLowerCase();
  const password = String(payload.password || '');
  const name = String(payload.name || '').trim().slice(0, 80);
  if (!email || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return sendJson(response, 400, { error: 'Use a valid email and a password of at least 8 characters.' });
  try {
    const collection = await getUsers();
    if (request.url === '/api/auth/register') {
      if (!name) return sendJson(response, 400, { error: 'Your name is required.' });
      const user = { name, email, passwordHash: await hashPassword(password), createdAt: new Date() };
      await collection.insertOne(user);
      setSession(response, user);
      return sendJson(response, 201, { user: { name, email } });
    }
    const user = await collection.findOne({ email });
    if (!user || !(await verifyPassword(password, user.passwordHash))) return sendJson(response, 401, { error: 'Email or password is incorrect.' });
    setSession(response, user);
    return sendJson(response, 200, { user: { name: user.name, email: user.email } });
  } catch (error) {
    if (error.code === 11000) return sendJson(response, 409, { error: 'An account with this email already exists.' });
    return sendJson(response, 503, { error: error.message || 'Authentication service is unavailable.' });
  }
}

async function handleMe(request, response) {
  const userId = getUserId(request);
  if (!userId) return sendJson(response, 401, { error: 'Please log in first.' });
  try {
    const user = await getUsers().then((collection) => collection.findOne({ _id: new ObjectId(userId) }));
    return user ? sendJson(response, 200, { user: { name: user.name, email: user.email } }) : sendJson(response, 401, { error: 'Please log in first.' });
  } catch { return sendJson(response, 401, { error: 'Please log in first.' }); }
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 25_000_000) throw new Error('Request is too large.');
  }
  return JSON.parse(body || '{}');
}

async function extractFileText(file) {
  if (!file?.data || !file?.name) return '';
  const extension = file.name.split('.').pop()?.toLowerCase() || 'bin';
  const temporaryDirectory = await mkdtemp(join(root, '.ocr-'));
  const imagePath = join(temporaryDirectory, `upload.${extension}`);
  try {
    await writeFile(imagePath, Buffer.from(file.data, 'base64'));
    const script = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension) ? 'image_ocr.py' : 'document_extract.py';
    const { stdout } = await execFileAsync(pythonCommand, [join(root, script), imagePath], { timeout: 45_000 });
    const result = JSON.parse(stdout);
    if (result.error) throw new Error(result.error);
    return result.text || '';
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Python document tools are not installed. Run: pip install -r requirements.txt.');
    throw new Error(error.message || 'I could not read that file. Check its format and install the requirements, then try again.');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function wantsDocument(text) {
  const normalized = text.toLowerCase()
    .replace(/genertae|genrate|genarate/g, 'generate')
    .replace(/docu?emt|documet|documnt|docuemnt/g, 'document')
    .replace(/\bdocs?\b/g, 'document');
  const request = /\b(create|make|generate|prepare|write|export|give|download|need|want)\b/.test(normalized);
  const documentType = /\b(document|docx|doc|word|report|research paper|notes|handout)\b/.test(normalized);
  return request && documentType;
}

function wantsResearchPaper(text) {
  return /\bresearch paper|academic paper|scholarly paper|research report\b/i.test(text);
}

async function createDocument(title, content) {
  await mkdir(downloadsDir, { recursive: true });
  const safeTitle = (title || 'engibot-document').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 70) || 'engibot-document';
  const fileName = `${safeTitle}-${Date.now()}.docx`;
  const inputDirectory = await mkdtemp(join(root, '.docx-'));
  const inputPath = join(inputDirectory, 'document.json');
  const outputPath = join(downloadsDir, fileName);
  try {
    await writeFile(inputPath, JSON.stringify({ title, content, output: outputPath }));
    await execFileAsync(pythonCommand, [join(root, 'create_docx.py'), inputPath], { timeout: 30_000 });
    return `/api/downloads/${encodeURIComponent(fileName)}`;
  } finally {
    await rm(inputDirectory, { recursive: true, force: true });
  }
}

function documentTitle(content) {
  const heading = content.match(/^#{1,3}\s+(.+)$/m)?.[1]?.replace(/[*_]/g, '').trim()
    || content.match(/^\*\*(.+?)\*\*\s*$/m)?.[1]?.trim();
  return heading || 'Engibot document';
}

async function handleChat(request, response) {
  const userId = getUserId(request);
  if (!userId) return sendJson(response, 401, { error: 'Please log in or create an account before chatting.' });
  if (!apiKey) {
    return sendJson(response, 500, { error: 'GROQ_API_KEY is missing. Add it to a .env file and restart the server.' });
  }

  let payload;
  try {
    payload = await readBody(request);
  } catch {
    return sendJson(response, 400, { error: 'Please send valid JSON.' });
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const latestUserMessage = [...messages].reverse().find((message) => message?.role === 'user' && typeof message.content === 'string');
  const documentRequested = Boolean(latestUserMessage && wantsDocument(latestUserMessage.content));
  const researchRequested = Boolean(latestUserMessage && wantsResearchPaper(latestUserMessage.content));
  let extractedText = '';
  if (payload.file) {
    try {
      extractedText = await extractFileText(payload.file);
    } catch (error) {
      return sendJson(response, 422, { error: error.message });
    }
  }
  const safeMessages = messages
    .filter((message) => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
    .slice(-16)
    .map(({ role, content }) => ({ role, content: content.slice(0, 6_000) }));

  if (!safeMessages.length || safeMessages.at(-1).role !== 'user') {
    return sendJson(response, 400, { error: 'A user message is required.' });
  }

  if (extractedText) {
    safeMessages[safeMessages.length - 1].content += `\n\n[Data extracted from the attached file]\n${extractedText.slice(0, 20_000)}`;
  }

  if (documentRequested) {
    safeMessages.push({
      role: 'user',
      content: 'DOCUMENT MODE: Use the topic, facts, and instructions from the entire conversation and any attached file. Produce the complete document now, not an outline and not a clarification question. If the topic is broad or a detail is missing, make a reasonable clearly labeled assumption and continue. Include a specific title, introduction, well-developed sections, and conclusion when appropriate. Use original wording and do not invent facts.'
    });
  }

  if (researchRequested) {
    safeMessages.push({
      role: 'user',
      content: 'RESEARCH PAPER MODE: Write a professional paper using the supplied topic and information. Include a title, abstract, keywords, introduction, background or literature context only when supported, methodology or approach when relevant, findings or analysis, discussion, conclusion, and references. Use original synthesis and simple accurate language. Do not invent studies, statistics, quotations, authors, URLs, or citations. If sources were not provided, state that the paper is based on the supplied information and label any assumptions.'
    });
  }

  try {
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [
          {
            role: 'system',
            content: 'You are Engibot, a thoughtful and communicative AI assistant. Use simple words and ask a short follow-up question when it would help the user continue. Read extracted file data carefully and say when something is unclear. Answer naturally in paragraphs or bullets. Use a markdown table only when the user explicitly asks for a table, tabular form, comparison table, or another structured grid. Use headings, bullets, and code blocks when the user asks for those formats. If the user asks for a document, report, Word file, notes, handout, or research paper, produce a complete, well-organized draft with a clear title, useful headings, accurate claims, and original wording. In document mode, do not respond with an outline or ask which topic to use when a topic exists in the conversation; use the supplied topic and information, make a labeled assumption if needed, and write the complete document. For research papers, never invent citations or factual sources. Do not imitate or copy source wording; summarize and synthesize in your own words. Be direct, warm, and honest about uncertainty.'
          },
          ...safeMessages
        ],
        temperature: 0.7,
        max_tokens: documentRequested ? 3_000 : 1_800
      })
    });

    const result = await groqResponse.json();
    if (!groqResponse.ok) {
      const message = result?.error?.message || 'The AI service could not answer right now.';
      return sendJson(response, groqResponse.status, { error: message });
    }

    const message = result.choices?.[0]?.message?.content || 'I did not receive a response.';
    const responsePayload = { message };
    if (documentRequested) {
      try {
        responsePayload.downloadUrl = await createDocument(documentTitle(message), message);
      } catch (error) {
        responsePayload.documentError = `I prepared the content, but could not create the Word file: ${error.message}`;
      }
    }
    return sendJson(response, 200, responsePayload);
  } catch (error) {
    return sendJson(response, 502, { error: error.message || 'Unable to reach the AI service.' });
  }
}

async function serveStatic(request, response) {
  const requestedPath = request.url === '/' ? '/index.html' : request.url.split('?')[0];
  const filePath = normalize(join(publicDir, requestedPath));
  if (!filePath.startsWith(publicDir)) return sendJson(response, 403, { error: 'Forbidden.' });

  try {
    const file = await readFile(filePath);
    response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream' });
    response.end(file);
  } catch {
    sendJson(response, 404, { error: 'Not found.' });
  }
}

export function requestHandler(request, response) {
  if (request.method === 'POST' && (request.url === '/api/auth/register' || request.url === '/api/auth/login')) return handleAuth(request, response);
  if (request.method === 'GET' && request.url === '/api/auth/me') return handleMe(request, response);
  if (request.method === 'POST' && request.url === '/api/chat') return handleChat(request, response);
  if (request.method === 'GET' && request.url.startsWith('/api/downloads/')) {
    const requestedName = decodeURIComponent(request.url.slice('/api/downloads/'.length));
    if (!/^[a-z0-9-]+\.docx$/i.test(requestedName)) return sendJson(response, 400, { error: 'Invalid download.' });
    return readFile(join(downloadsDir, requestedName)).then((file) => {
      response.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': `attachment; filename="${requestedName}"` });
      response.end(file);
    }).catch(() => sendJson(response, 404, { error: 'Document not found.' }));
  }
  if (request.method === 'GET') return serveStatic(request, response);
  return sendJson(response, 405, { error: 'Method not allowed.' });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = http.createServer(requestHandler);
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Stop the existing server or set another PORT in .env.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  });

  server.listen(port, () => {
    console.log(`Engibot is running at http://localhost:${port}`);
  });
}
