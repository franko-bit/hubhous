import OpenAI from 'openai';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const workspaceRoot = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.HUBHOME_PORT || process.env.PORT || 3002);
const envPath = path.join(workspaceRoot, '.env');

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .reduce((values, line) => {
      const separator = line.indexOf('=');
      if (separator >= 0) {
        values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
      }
      return values;
    }, {});
}

const env = loadEnv(envPath);
const API_KEY = process.env.NVIDIA_API_KEY || env.NVIDIA_API_KEY;
const BASE_URL = process.env.NVIDIA_BASE_URL || env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const MODEL = process.env.OPENAI_MODEL || env.OPENAI_MODEL || 'deepseek-ai/deepseek-v4-flash-0731';
const TIMEOUT_MS = Number(process.env.HUBHOME_TIMEOUT_MS || env.HUBHOME_TIMEOUT_MS || 30000);
const USE_FALLBACK = process.env.USE_FALLBACK === 'true' || env.USE_FALLBACK === 'true';
const conversations = new Map();
let providerUnavailableUntil = 0;

const HUBHOME_PROMPT = `You are the friendly HUBHOME booking concierge.

HUBHOME provides professional real-estate photography services for homes, apartments, rentals, developments, and commercial properties. Services include property photography, short property videos, photo and video packages, and aerial add-ons.

Customers are homeowners, landlords, real-estate agents, and property managers who need content to sell or rent a property.
- Keep replies concise, warm, and practical.
- Help the customer choose the right photography service.
- Ask naturally for missing details: property type, selling or renting goal, service, preferred date and time, name, WhatsApp contact, and access or shot-list notes.
- Remember details already provided and do not ask for them again.
- Never invent prices, availability, or confirmed bookings.
- When the details are complete, summarize them and explain that the request will be confirmed through WhatsApp.
- Never mention printing, print products, quantities, paper, or production.
- Answer in the customer's language when possible.`;

function getConversation(sessionId) {
  const key = String(sessionId || 'anonymous').trim().slice(0, 100) || 'anonymous';
  if (!conversations.has(key)) conversations.set(key, []);
  return conversations.get(key);
}

function remember(conversation, role, content) {
  conversation.push({ role, content });
  if (conversation.length > 12) conversation.splice(0, conversation.length - 12);
}

function writeEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function fallbackResponse(message, conversation) {
  const history = conversation.map((entry) => entry.content).join(' ');
  const hasDate = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(history);
  const hasContact = /(?:\+?250|0)7\d{8}/.test(history.replace(/\s/g, ''));
  const hasName = /\b(?:my name is|name is|i am|is the name)\b/i.test(history);
  if (/^(hi|hello|hey|yoo)\b/i.test(message.trim())) {
    return 'Hello! Welcome to HUBHOME. What kind of property are you marketing, and are you selling, renting, or showcasing it?';
  }
  if (hasDate && hasContact && hasName) {
    return 'Thanks, I have your name, preferred date, and WhatsApp number. What time would you prefer for the shoot, and are there any access instructions or rooms you want us to prioritize?';
  }
  return 'I can help arrange your HUBHOME shoot. What property type is it, what service do you need, and what date and time would you prefer?';
}

app.use(cors());
app.use(express.json());
app.use(express.static(workspaceRoot));

app.get('/', (req, res) => res.sendFile(path.join(workspaceRoot, 'hubindx.html')));
app.get('/hubindx.html', (req, res) => res.sendFile(path.join(workspaceRoot, 'hubindx.html')));

app.get('/api/hubhome/health', (req, res) => {
  res.json({ status: 'ok', aiConfigured: Boolean(API_KEY), mode: USE_FALLBACK ? 'fallback' : 'live', port: PORT });
});

app.get('/api/hubhome/diagnostics', async (req, res) => {
  const result = { mode: USE_FALLBACK ? 'fallback' : 'live', apiKey: API_KEY ? 'set' : 'missing', timeout: TIMEOUT_MS, apiConnectivity: 'not tested' };
  if (!API_KEY || USE_FALLBACK) return res.json(result);
  try {
    const client = new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL, timeout: TIMEOUT_MS, maxRetries: 0 });
    await Promise.race([
      client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 5 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Test timeout')), TIMEOUT_MS)),
    ]);
    result.apiConnectivity = 'connected';
  } catch (error) {
    result.apiConnectivity = `error: ${error.message}`;
  }
  res.json(result);
});

app.post(['/api/hubhome/chat', '/api/chat'], async (req, res) => {
  const { message, sessionId } = req.body || {};
  if (!String(message || '').trim()) return res.status(400).json({ error: 'Message is required' });

  const conversation = getConversation(sessionId);
  const cleanMessage = String(message).trim();
  remember(conversation, 'user', cleanMessage);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (USE_FALLBACK || !API_KEY || Date.now() < providerUnavailableUntil) {
    writeEvent(res, { type: 'source', source: 'fallback' });
    const content = fallbackResponse(cleanMessage, conversation);
    remember(conversation, 'assistant', content);
    writeEvent(res, { type: 'content', content });
    writeEvent(res, '[DONE]');
    return res.end();
  }

  try {
    const client = new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL, timeout: TIMEOUT_MS, maxRetries: 0 });
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: HUBHOME_PROMPT }, ...conversation],
      temperature: 0.2,
      max_tokens: 500,
      stream: true,
    });
    let content = '';
    writeEvent(res, { type: 'source', source: 'ai' });
    for await (const chunk of completion) {
      const part = chunk.choices[0]?.delta?.content || '';
      if (part) {
        content += part;
        writeEvent(res, { type: 'content', content: part });
      }
    }
    remember(conversation, 'assistant', content || 'Please tell me more about the property shoot you need.');
    writeEvent(res, '[DONE]');
    res.end();
  } catch (error) {
    console.error('HUBHOME AI error:', error.message);
    providerUnavailableUntil = Date.now() + 5000;
    writeEvent(res, { type: 'source', source: 'fallback' });
    const content = fallbackResponse(cleanMessage, conversation);
    remember(conversation, 'assistant', content);
    writeEvent(res, { type: 'content', content });
    writeEvent(res, '[DONE]');
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`HUBHOME server2 running at http://localhost:${PORT}`);
  console.log(`Page: http://localhost:${PORT}/hubindx.html`);
  console.log(`AI: ${API_KEY ? 'configured' : 'not configured'}; mode: ${USE_FALLBACK ? 'fallback' : 'live'}`);
});
