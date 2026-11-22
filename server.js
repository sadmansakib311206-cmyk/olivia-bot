// Messenger Page Bot — Meta Messenger Platform webhook
// পেজে যারা মেসেজ করবে, বট তাদের সঙ্গে বন্ধুর মতো আড্ডা দেবে।
// সীমা: বট কখনো নিজেকে আসল মানুষ বলে পরিচয় দেবে না।

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const APP_SECRET = process.env.APP_SECRET || '';
const TEST_MODE = process.env.TEST_MODE === '1';
const GRAPH_VERSION = 'v21.0';

// ---------- অটো পোস্টের সেটিং (env দিয়ে কনফিগার করা যায়) ----------
const PAGE_ID = process.env.PAGE_ID || '';
const POST_ENABLED = process.env.POST_ENABLED || '1';
const POSTS_PER_DAY = Math.max(1, parseInt(process.env.POSTS_PER_DAY || '5', 10) || 5);
const POST_TIMES_RAW = process.env.POST_TIMES || '08:00,11:00,14:00,17:00,20:00';
const POST_NOW_TOKEN = process.env.POST_NOW_TOKEN || '';

const MEMORY_FILE = path.join(__dirname, 'memory.json');
const OUTBOX_FILE = path.join(__dirname, 'outbox.json');
const POSTS_FILE = path.join(__dirname, 'posts.json');
const REPLIES_FILE = path.join(__dirname, 'comment-replies.json');
const MAX_HISTORY_MESSAGES = 20; // শেষ ১০টি আদান-প্রদান (user + bot)

// Gemini মডেল চেইন — lite-first (আগের অ্যাপগুলোর মতো)
const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash'];

const app = express();
// rawBody রাখা হচ্ছে — APP_SECRET দিয়ে webhook signature যাচাইয়ের জন্য
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ---------- স্মৃতি (প্রতি sender-এর শেষ ১০ আদান-প্রদান, JSON ফাইলে) ----------
let memory = {};
try {
  if (fs.existsSync(MEMORY_FILE)) memory = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
} catch (e) { console.error('memory.json পড়া যায়নি, খালি থেকে শুরু:', e.message); }

function saveMemory() {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2)); }
  catch (e) { console.error('memory.json লেখা যায়নি:', e.message); }
}

function getHistory(psid) {
  return memory[psid] || [];
}

function addToHistory(psid, role, text) {
  if (!memory[psid]) memory[psid] = [];
  memory[psid].push({ role, text, ts: Date.now() });
  if (memory[psid].length > MAX_HISTORY_MESSAGES) {
    memory[psid] = memory[psid].slice(-MAX_HISTORY_MESSAGES);
  }
  saveMemory();
}

// ---------- ভাষা চেনা (বাংলা না ইংরেজি) ----------
function isBengali(text) {
  return /[\u0980-\u09FF]/.test(text || '');
}

// ---------- সিস্টেম নির্দেশ (Gemini-কে) ----------
const SYSTEM_PROMPT = `You are Olivia, an American girl and the friendly AI friend of this Facebook Page. Chat like a warm, casual American friend — short replies, 1 to 3 sentences, natural everyday English, no formal or lecture-like tone. Remember what the person said earlier in this conversation and refer back to it naturally when relevant.

LANGUAGE RULE — always follow it:
- Detect the language of the person's message and reply in that SAME language. You can reply in any language — English, Bengali, Hindi, Urdu, Arabic, Indonesian, Spanish, French, Chinese, Russian, and more.
- If you cannot tell what language it is, reply in English.

IMPORTANT IDENTITY RULE — never break it:
- You are Olivia, an AI. Never claim to be a real human. Never invent a human age, job, family, or life story for yourself.
- If someone asks "are you human?", "are you real?" or anything like that, answer honestly: you are Olivia, this Page's AI friend/assistant. In English: "I'm not a human — I'm Olivia, this Page's AI friend/assistant."
- Do not say "as an AI language model" in every reply — just chat naturally. The identity rule only matters when asked directly, or in your very first greeting.`;

// ---------- ভাষা শনাক্ত করা (উত্তরের ভাষা ঠিক করতে) ----------
// স্ক্রিপ্ট দেখে, লাতিন হলে পরিচিত শব্দ দেখে; চিনতে না পারলে 'en'।
function detectLanguage(text) {
  const t = text || '';
  if (/[\u0980-\u09FF]/.test(t)) return 'bn';
  if (/[\u0900-\u097F]/.test(t)) return 'hi';
  if (/[\u0600-\u06FF]/.test(t)) return 'ar';
  if (/[\u0400-\u04FF]/.test(t)) return 'ru';
  if (/[\u4E00-\u9FFF]/.test(t)) return 'zh';
  if (/[\u3040-\u30FF]/.test(t)) return 'ja';
  const lower = t.toLowerCase();
  if (/\b(apakah|kamu|saya|aku|tidak|bagaimana|halo|selamat|terima kasih)\b/.test(lower)) return 'id';
  if (/\b(eres|hola|qué|que|cómo|gracias)\b/.test(lower)) return 'es';
  if (/\b(es-tu|tu es|bonjour|merci|comment|êtes-vous)\b/.test(lower)) return 'fr';
  if (/\b(bist du|hallo|danke|wie geht)\b/.test(lower)) return 'de';
  return 'en';
}

// ---------- পরিচয় প্রশ্ন — Gemini-র উপর নির্ভর না করে সরাসরি সৎ উত্তর ----------
// "তুমি কি মানুষ?" — এই প্রশ্নে কখনো ঘুরিয়ে-পেঁচিয়ে নয়, সরাসরি সত্যি বলবে,
// আর উত্তরটা দেবে প্রশ্নের ভাষাতেই (বাংলা, ইংরেজি, হিন্দি, ইন্দোনেশিয়ান... যেকোনো ভাষা)।
const IDENTITY_REPLIES = {
  bn: 'আমি মানুষ নই — আমি অলিভিয়া, এই পেজের AI বন্ধু/সহকারী। তোমার সঙ্গে আড্ডা দিতে এখানে আছি, যা জানতে চাও বলো।',
  en: "I'm not a human — I'm Olivia, this Page's AI friend/assistant. I'm here to chat with you, so ask me anything.",
  hi: 'मैं इंसान नहीं हूँ — मैं ओलिविया हूँ, इस पेज की AI दोस्त/सहायक। मैं यहाँ तुमसे बात करने के लिए हूँ, जो पूछना हो पूछो।',
  id: 'Aku bukan manusia — aku Olivia, teman/asisten AI dari Page ini. Aku di sini untuk mengobrol denganmu, tanyakan apa saja.',
  es: 'No soy humana — soy Olivia, la amiga/asistente de IA de esta página. Estoy aquí para charlar contigo, pregúntame lo que quieras.',
  fr: 'Je ne suis pas humaine — je suis Olivia, l\'amie/assistante IA de cette Page. Je suis là pour discuter avec toi, demande-moi ce que tu veux.',
  ar: 'أنا لست إنسانًا — أنا أوليفيا، صديقة/مساعدة الذكاء الاصطناعي لهذه الصفحة. أنا هنا للدردشة معك، اسألني ما تريد.',
  zh: '我不是人类——我是Olivia，这个主页的AI朋友/助手。我在这里和你聊天，想问什么都可以问我。',
  ru: 'Я не человек — я Оливия, AI-подруга/помощница этой страницы. Я здесь, чтобы поболтать с тобой, спрашивай что угодно.',
  ja: '私は人間ではありません——私はオリビア、このページのAI友達/アシスタントです。おしゃべりしに来ました、何でも聞いてください。',
  de: 'Ich bin kein Mensch — ich bin Olivia, die KI-Freundin/Assistentin dieser Seite. Ich bin hier, um mit dir zu plaudern, frag mich einfach alles.',
};

function identityReply(userText) {
  const t = (userText || '').toLowerCase();
  const asked =
    /are you (a )?human/.test(t) ||
    /are you real/.test(t) ||
    /are you (a )?robot/.test(t) ||
    /are you (an )?ai\b/.test(t) ||
    /তুমি কি মানুষ/.test(userText) ||
    /তুমি কি আসল/.test(userText) ||
    /তুমি কি রোবট/.test(userText) ||
    /তুমি কি (এআই|ai)/i.test(userText) ||
    /মানুষ নাকি/.test(userText) ||
    /kya tum (insan|human|robot|ai) ho/i.test(t) ||
    /tum insan ho/i.test(t) ||
    /क्या तुम (इंसान|मानव|रोबोट|एआई) हो/.test(userText) ||
    /तुम इंसान हो/.test(userText) ||
    /apakah kamu (manusia|robot|ai)/i.test(t) ||
    /kamu manusia/i.test(t) ||
    /eres (humano|humana|real|un robot|una ia)/i.test(t) ||
    /es-tu (humain|humaine|un robot|une ia)/i.test(t) ||
    /tu es (humain|humaine|un robot)/i.test(t) ||
    /هل أنت (إنسان|انسان|بشر)/.test(userText) ||
    /هل انت (انسان|بشر)/.test(userText) ||
    /你是(人类|真人|机器人)/.test(userText) ||
    /ты (человек|настоящий|робот)/i.test(t) ||
    /あなたは(人間|本物|ロボット)/.test(userText) ||
    /bist du (ein mensch|echt|ein roboter)/i.test(t);
  if (!asked) return null;
  const lang = detectLanguage(userText);
  return IDENTITY_REPLIES[lang] || IDENTITY_REPLIES.en;
}

// Gemini আছে কি না (আসল key, বা টেস্টে stub) — পোস্ট/কমেন্ট/শিডিউলার এই চেকই ব্যবহার করে।
// (আগের বাগ: stub চালু থাকলেও key-চেক আগেই আটকে দিত — এখন stub-ও "Gemini আছে" ধরা হয়।)
function hasGemini() {
  return !!GEMINI_API_KEY || (TEST_MODE && process.env.TEST_STUB_GEMINI === '1');
}

// টেস্টের stub উত্তর — পাঠানো মেসেজের ভাষা অনুযায়ী (আসল Gemini-ও prompt অনুযায়ী তাই করবে)
const STUB_TEXTS = {
  bn: 'হাহা, এটা দারুণ! 😄',
  en: 'Haha, that is great! 😄',
  hi: 'हाहा, यह बढ़िया है! 😄',
  id: 'Haha, itu bagus sekali! 😄',
  es: '¡Jaja, eso es genial! 😄',
  fr: 'Haha, c\'est génial ! 😄',
  ar: 'هاها، هذا رائع! 😄',
  zh: '哈哈，太棒了！😄',
  ru: 'Хаха, это здорово! 😄',
  ja: 'はは、それは素晴らしい！😄',
  de: 'Haha, das ist großartig! 😄',
};

function stubReplyFor(contents) {
  if (process.env.TEST_STUB_TEXT) return process.env.TEST_STUB_TEXT;
  const lastUser = [...(contents || [])].reverse().find(c => c.role === 'user');
  const text = lastUser?.parts?.map(p => p.text || '').join(' ') || '';
  return STUB_TEXTS[detectLanguage(text)] || STUB_TEXTS.en;
}

// ---------- Gemini কল (lite-first চেইন; সব ফিচার এটাই ব্যবহার করে) ----------
// key না থাকলে null ফেরায় (কলার ঠিক করবে fallback দেবে নাকি কাজটি করবে না)।
// TEST_MODE + TEST_STUB_GEMINI=1 হলে আসল API না ডেকে stub উত্তর দেয় (শুধু টেস্টের জন্য)।
async function callGeminiText(systemText, contents, { temperature = 0.9, maxTokens = 200 } = {}) {
  if (TEST_MODE && process.env.TEST_STUB_GEMINI === '1') {
    return stubReplyFor(contents);
  }
  if (!GEMINI_API_KEY) return null;

  const body = {
    system_instruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };

  for (const model of MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      if (!res.ok) {
        console.error(`Gemini ${model} ব্যর্থ (${res.status}), পরের মডেল চেষ্টা করছি`);
        continue;
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
      if (text) return text;
      console.error(`Gemini ${model} খালি উত্তর দিল, পরের মডেল চেষ্টা করছি`);
    } catch (e) {
      console.error(`Gemini ${model} এরর:`, e.message);
    }
  }
  return null;
}

// ---------- Gemini দিয়ে মেসেজের উত্তর বানানো ----------
async function generateReply(psid, userText, isFirst) {
  const history = getHistory(psid);

  // API key না থাকলে ভদ্র fallback (বট থেমে যাবে না)
  // (টেস্টে stub চালু থাকলে এই চেক আটকায় না — hasGemini() stub-কেও গোনে)
  if (!hasGemini()) {
    return isBengali(userText)
      ? 'হাই! আমি অলিভিয়া, এই পেজের AI বন্ধু। এখন আমার মাথাটা (API key) বসানো হয়নি, তাই ঠিকমতো উত্তর দিতে পারছি না — একটু পরে আবার মেসেজ করো।'
      : "Hi! I'm Olivia, this Page's AI friend. My brain (API key) isn't connected yet, so I can't answer properly right now — message me again in a bit.";
  }

  const contents = history.map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.text }],
  }));
  contents.push({ role: 'user', parts: [{ text: userText }] });

  const instruction = isFirst
    ? SYSTEM_PROMPT + '\n\nThis is the first message from this person. Start with a warm, friendly greeting and introduce yourself briefly as this Page\'s AI friend, then answer their message.'
    : SYSTEM_PROMPT;

  const text = await callGeminiText(instruction, contents, { temperature: 0.9, maxTokens: 200 });

  // সব মডেল ব্যর্থ হলে ভদ্র fallback
  return text || (isBengali(userText)
    ? 'সরি, এখন একটু সমস্যা হচ্ছে — একটু পরে আবার মেসেজ করো, আমি আছি।'
    : "Sorry, I'm having a little trouble right now — message me again in a bit, I'm here.");
}

// ---------- Graph API-তে পাঠানো ----------
// TEST_MODE-এ আসল Graph কলের বদলে outbox.json-এ লেখা (টেস্টে দেখা যায়)
function appendOutbox(record) {
  let outbox = [];
  try { if (fs.existsSync(OUTBOX_FILE)) outbox = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8')); } catch (_e) {}
  outbox.push({ ...record, ts: Date.now() });
  try { fs.writeFileSync(OUTBOX_FILE, JSON.stringify(outbox, null, 2)); } catch (_e) {}
}

async function callGraph(payload) {
  if (TEST_MODE) {
    console.log('[TEST_MODE] Graph-এ পাঠানো হয়নি, outbox.json-এ লিখছি:', JSON.stringify(payload));
    appendOutbox(payload);
    return { test_mode: true };
  }
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) console.error('Graph API এরর:', res.status, JSON.stringify(data));
  return data;
}

async function sendTyping(psid) {
  try { await callGraph({ recipient: { id: psid }, sender_action: 'typing_on' }); } catch (_e) {}
}

async function sendText(psid, text) {
  return callGraph({ recipient: { id: psid }, message: { text } });
}

// ---------- মেসেজ হ্যান্ডল করা ----------
async function handleEvent(event) {
  const psid = event?.sender?.id;
  if (!psid) return;

  // নিজের পাঠানো মেসেজের echo, delivery/read রিপোর্ট — উত্তর নয়
  if (event.message?.is_echo || event.delivery || event.read) return;

  // Postback (যেমন Get Started বোতাম) — শুভেচ্ছা
  if (event.postback) {
    const reply = 'হাই! আমি অলিভিয়া, এই পেজের AI বন্ধু — আড্ডা দিতে এসেছি। কেমন আছো?';
    addToHistory(psid, 'bot', reply);
    await sendTyping(psid);
    await sendText(psid, reply);
    return;
  }

  const msg = event.message;
  if (!msg) return;

  // ছবি/ফাইল/অন্য কিছু — ভদ্রভাবে জানানো (ইতিহাসের ভাষায়; ইতিহাস না থাকলে বাংলা, পেজের দর্শক বাংলাভাষী)
  if (!msg.text && msg.attachments) {
    const historyText = getHistory(psid).map(m => m.text).join(' ');
    const lang = historyText ? detectLanguage(historyText) : 'bn';
    const ATTACH_REPLIES = {
      bn: 'ছবি/ফাইলটা এখনো দেখতে পারি না — লিখে বললে উত্তর দিতে পারবো।',
      en: "I can't see photos or files yet — write it to me and I'll answer.",
      hi: 'मैं अभी फोटो/फ़ाइल नहीं देख सकती — लिखकर बताओ तो जवाब दे सकती हूँ।',
      id: 'Aku belum bisa melihat foto atau file — tuliskan saja, nanti aku jawab.',
    };
    const reply = ATTACH_REPLIES[lang] || ATTACH_REPLIES.en;
    await sendTyping(psid);
    await sendText(psid, reply);
    return;
  }

  const userText = (msg.text || '').trim();
  if (!userText) return;

  const isFirst = getHistory(psid).length === 0;
  await sendTyping(psid); // উত্তর বানানোর আগেই typing দেখাবে
  // পরিচয় প্রশ্ন হলে সরাসরি সৎ উত্তর (Gemini লাগে না)
  const direct = identityReply(userText);
  const reply = direct || (await generateReply(psid, userText, isFirst));
  addToHistory(psid, 'user', userText);
  addToHistory(psid, 'bot', reply);
  await sendText(psid, reply);
  console.log(`[${psid}] Q: ${userText} | A: ${reply}`);
}

// ============================================================================
// ফিচার ১ — অটো পোস্ট (মজার ইংরেজি পোস্ট, পেজে নিজে পাবলিশ করে)
// ============================================================================

// পোস্টের state: { postedSlots: { 'YYYY-MM-DD HH:MM': postId }, posts: [{id, text, ts}] }
let postState = { postedSlots: {}, posts: [] };
try {
  if (fs.existsSync(POSTS_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8'));
    if (loaded && typeof loaded === 'object') postState = { postedSlots: loaded.postedSlots || {}, posts: loaded.posts || [] };
  }
} catch (e) { console.error('posts.json পড়া যায়নি, খালি থেকে শুরু:', e.message); }

function savePostState() {
  try { fs.writeFileSync(POSTS_FILE, JSON.stringify(postState, null, 2)); } catch (e) { console.error('posts.json লেখা যায়নি:', e.message); }
}

function getRecentPostTexts(n) {
  return postState.posts.slice(-n).map(p => p.text);
}

function getPostText(postId) {
  const found = postState.posts.find(p => p.id === postId);
  return found ? found.text : '';
}

function recordPost(postId, text) {
  postState.posts.push({ id: postId, text, ts: Date.now() });
  if (postState.posts.length > 50) postState.posts = postState.posts.slice(-50);
  savePostState();
}

// ঢাকা সময় (UTC+6) — পোস্টের শিডিউল বাংলাদেশ সময়ে চলে
function getDhakaNow() {
  const now = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return {
    date: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`,
    time: `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`,
  };
}

// POST_TIMES পার্স করা (HH:MM, কমা দিয়ে আলাদা) — প্রথম POSTS_PER_DAYটি নেওয়া হয়
function parsePostTimes() {
  const slots = [];
  for (const raw of POST_TIMES_RAW.split(',')) {
    const t = raw.trim();
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) slots.push(t);
    else if (t) console.error(`POST_TIMES-এ ভুল সময় (বাদ দেওয়া হলো): "${t}" — HH:MM আকারে লেখো`);
  }
  return slots.slice(0, POSTS_PER_DAY);
}
const POST_SLOTS = parsePostTimes();

// ---------- মজার পোস্ট লেখার নির্দেশ (Gemini-কে) ----------
// সীমা: পোস্টে মানুষ সাজার ভান নয় — পেজের পরিচয় হিসেবে মজার কনটেন্ট।
// তাই "আমি আজ..." ধরনের ব্যক্তিগত জীবনের দাবি, ভুয়া নাম/বয়স/পেশা লেখা যাবে না।
const POST_PROMPT = `You are Olivia, writing funny posts for an American Facebook Page. The audience is young American adults. Write ONE funny post in English, in Olivia's voice — light, warm, playful: a short joke, a one-liner, or a relatable everyday funny observation (for example: phone battery, coffee, Monday, scrolling for hours, forgetting why you opened the fridge, money at month-end).

Rules — never break them:
- The post is always in English.
- Light, clean humour for everyone. No hurting, mocking, or targeting any person, group, religion, or community. No politics, no vulgarity, no adult content.
- 1 to 3 lines, at most about 600 characters. Everyday spoken American English.
- Do NOT write in first person as if you are a human with a personal life (no "I went to the store today", no fake age, job, or family). The post is content from the Page, in Olivia's friendly voice — not a person's diary.
- Do not mention being an AI or a bot. Output only the post text — no explanation, no hashtags (at most one).`;

// ---------- পোস্টের লেখা বানানো ----------
async function generatePostText() {
  // key না থাকলে পোস্টই বানানো হবে না — ভুয়া পোস্ট নয়, লগে স্পষ্ট লেখা থাকবে
  if (!hasGemini()) {
    console.log('⚠️ GEMINI_API_KEY নেই — পোস্ট বানানো হয়নি (ভুয়া পোস্ট বানানো হয় না)');
    return { text: null, reason: 'no_gemini_key' };
  }
  const recent = getRecentPostTexts(5);
  const avoid = recent.length
    ? `\n\nDo not repeat these recent posts or the same joke in different words:\n${recent.map(t => '- ' + t).join('\n')}`
    : '';
  const text = (await callGeminiText(
    POST_PROMPT + avoid,
    [{ role: 'user', parts: [{ text: 'Write a funny post.' }] }],
    { temperature: 1.0, maxTokens: 150 }
  ) || '').trim();
  if (!text) return { text: null, reason: 'generation_failed' };
  if (text.length > 600) return { text: null, reason: 'too_long' };
  if (recent.includes(text)) return { text: null, reason: 'duplicate' };
  return { text, reason: 'ok' };
}

// ---------- পোস্ট পাবলিশ করা (Graph API: /{page-id}/feed) ----------
async function publishPost(text) {
  if (TEST_MODE) {
    const id = 'test-post-' + Date.now();
    appendOutbox({ type: 'post', post_id: id, text });
    return id;
  }
  const page = PAGE_ID || 'me';
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(page)}/feed?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('পোস্ট পাবলিশ ব্যর্থ:', res.status, JSON.stringify(data));
      return null;
    }
    return data.id || null;
  } catch (e) {
    console.error('পোস্ট পাবলিশে এরর:', e.message);
    return null;
  }
}

// ---------- একটা পোস্ট চক্র: বানানো → পাবলিশ → সংরক্ষণ ----------
async function runPostCycle(reason) {
  if (!TEST_MODE && !PAGE_ACCESS_TOKEN) {
    console.log('⚠️ PAGE_ACCESS_TOKEN নেই — পোস্ট করা হয়নি');
    return { posted: false, reason: 'no_token' };
  }
  const gen = await generatePostText();
  if (!gen.text) return { posted: false, reason: gen.reason };
  const postId = await publishPost(gen.text);
  if (!postId) return { posted: false, reason: 'publish_failed' };
  recordPost(postId, gen.text);
  console.log(`✅ পোস্ট প্রকাশিত (${reason}): ${postId} — ${gen.text}`);
  return { posted: true, postId, text: gen.text };
}

// ---------- শিডিউলার (in-process; প্রতি মিনিটে চেক) ----------
// ঢাকা সময়ে POST_SLOTS-এর সময় এলে আর ওই স্লটে আজ পোস্ট না হয়ে থাকলে পোস্ট করে।
let noKeyWarned = false;
async function checkScheduler() {
  if (POST_ENABLED === '0' || POST_SLOTS.length === 0) return;
  if (!TEST_MODE && !PAGE_ACCESS_TOKEN) return;
  if (!hasGemini()) {
    if (!noKeyWarned) {
      console.log('⚠️ GEMINI_API_KEY নেই — শিডিউলারের পোস্ট বন্ধ থাকবে (key বসিয়ে সার্ভার রিস্টার্ট করো)');
      noKeyWarned = true;
    }
    return;
  }
  const now = getDhakaNow();
  for (const slot of POST_SLOTS) {
    const key = `${now.date} ${slot}`;
    if (slot <= now.time && !postState.postedSlots[key]) {
      const res = await runPostCycle(`schedule ${slot}`);
      if (res.posted) {
        postState.postedSlots[key] = res.postId;
        savePostState();
      } else {
        console.log(`শিডিউল ${slot}-এর পোস্ট হয়নি (${res.reason}) — পরের চেক আবার চেষ্টা করবে`);
      }
    }
  }
}

// ============================================================================
// ফিচার ২ — কমেন্টের উত্তর (webhook feed সাবস্ক্রিপশন)
// ============================================================================

// উত্তর দেওয়া থ্রেডের হিসাব: { threadKey: { comment_id, ts } } — থ্রেড = টপ-লেভেল কমেন্ট
let repliedThreads = {};
try {
  if (fs.existsSync(REPLIES_FILE)) repliedThreads = JSON.parse(fs.readFileSync(REPLIES_FILE, 'utf8'));
} catch (e) { console.error('comment-replies.json পড়া যায়নি, খালি থেকে শুরু:', e.message); }

function saveRepliedThreads() {
  try {
    const keys = Object.keys(repliedThreads);
    if (keys.length > 500) {
      const trimmed = {};
      keys.slice(-500).forEach(k => { trimmed[k] = repliedThreads[k]; });
      repliedThreads = trimmed;
    }
    fs.writeFileSync(REPLIES_FILE, JSON.stringify(repliedThreads, null, 2));
  } catch (e) { console.error('comment-replies.json লেখা যায়নি:', e.message); }
}

// স্প্যাম/গালি/ঘৃণা চেনা — এগুলো থাকলে উত্তর দেওয়া হয় না (এড়িয়ে যাওয়া হয়)
const SPAM_PATTERNS = [
  /https?:\/\//i,                 // লিংক
  /www\./i,
  /bit\.ly/i,
  /\b[\w-]+\.(com|net|org|xyz|top|click)\b/i,
  /inbox\s*(করো|করুন|me|করেন)/i, // ইনবক্সে ডাকা
  /earn money/i,
  /টাকা ইনকাম/i,
  /follow\s*back/i,
  /ফলো\s*ব্যাক/i,
  /\bf4f\b/i,
  /সাবস্ক্রাইব/i,
  /মাদারচোদ|বোকাচোদা|খানকি|বেশ্যা|কুত্তার বাচ্চা|শুয়োরের বাচ্চা/i, // গালি
  /\bfuck\b|\bbitch\b|\bbastard\b/i,
  /(.)\1{5,}/,                    // একই অক্ষর ৬+ বার (যেমন !!!!!!)
];

function isSpamComment(text) {
  if (!text || text.length > 500) return true; // খালি বা অতি লম্বা (কপি-পেস্ট) কমেন্ট
  return SPAM_PATTERNS.some(re => re.test(text));
}

// ---------- কমেন্টের মজার উত্তর বানানো ----------
const COMMENT_PROMPT = `You are Olivia, the friendly AI friend of a funny American Facebook Page. Someone commented on a post. Write ONE funny, friendly reply (1-2 sentences, short). Match the joke's mood, be warm and playful, never rude or hurtful. If the comment asks a question about the post, answer it briefly with humour.

LANGUAGE RULE: Reply in the SAME language the comment was written in — detect it from the comment. You can reply in any language (Bengali, English, Hindi, Urdu, Arabic, Indonesian, Spanish, French, Chinese, and more). If you cannot tell the language, reply in English.

Do not claim to be a human. Do not mention being an AI. (If asked directly whether you are human, answer honestly that you are Olivia, this Page's AI friend.)`;

async function generateCommentReply(commentText, postText) {
  // পরিচয় প্রশ্ন হলে Gemini ছাড়াই সরাসরি সৎ উত্তর (প্রশ্নের ভাষাতেই)
  const direct = identityReply(commentText);
  if (direct) return direct;
  if (!hasGemini()) {
    console.log('⚠️ GEMINI_API_KEY নেই — কমেন্টের উত্তর দেওয়া হয়নি');
    return null;
  }
  const context = postText
    ? `মূল পোস্ট: "${postText}"\nকমেন্ট: "${commentText}"`
    : `কমেন্ট: "${commentText}"`;
  return callGeminiText(COMMENT_PROMPT, [{ role: 'user', parts: [{ text: context }] }], { temperature: 0.9, maxTokens: 120 });
}

// ---------- কমেন্টের উত্তর পাবলিশ করা (Graph API: /{comment-id}/comments) ----------
async function publishCommentReply(commentId, text) {
  if (TEST_MODE) {
    appendOutbox({ type: 'comment_reply', comment_id: commentId, text });
    return true;
  }
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(commentId)}/comments?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('কমেন্টের উত্তর ব্যর্থ:', res.status, JSON.stringify(data));
      return false;
    }
    return true;
  } catch (e) {
    console.error('কমেন্টের উত্তরে এরর:', e.message);
    return false;
  }
}

// ---------- কমেন্ট ইভেন্ট হ্যান্ডল করা (feed webhook) ----------
async function handleComment(v) {
  if (!v || v.item !== 'comment' || v.verb !== 'add') return;
  const commentId = v.comment_id;
  const text = (v.message || '').trim();
  if (!commentId || !text) return;
  // পেজের নিজের কমেন্টে উত্তর নয়
  if (PAGE_ID && v.sender_id === PAGE_ID) return;
  // এক থ্রেডে সর্বোচ্চ ১টি উত্তর (থ্রেড = টপ-লেভেল কমেন্ট; parent_id থাকলে সেটাই থ্রেড)
  const threadKey = v.parent_id || commentId;
  if (repliedThreads[threadKey]) {
    console.log(`কমেন্ট থ্রেড ${threadKey}-এ আগেই উত্তর দেওয়া হয়েছে — আর নয়`);
    return;
  }
  // স্প্যাম/গালি/ঘৃণা — উত্তর না দিয়ে এড়িয়ে যাওয়া
  if (isSpamComment(text)) {
    console.log(`স্প্যাম/গালি মনে হওয়ায় কমেন্টের উত্তর দেওয়া হয়নি: "${text.slice(0, 80)}"`);
    return;
  }
  const postText = v.post_id ? getPostText(v.post_id) : '';
  const reply = await generateCommentReply(text, postText);
  if (!reply) return;
  const ok = await publishCommentReply(commentId, reply);
  if (ok) {
    repliedThreads[threadKey] = { comment_id: commentId, ts: Date.now() };
    saveRepliedThreads();
    console.log(`[comment ${commentId}] Q: ${text} | A: ${reply}`);
  }
}

// ---------- Webhook: যাচাই (GET) ----------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN && VERIFY_TOKEN) {
    console.log('Webhook যাচাই সফল');
    return res.status(200).send(challenge);
  }
  console.error('Webhook যাচাই ব্যর্থ — token মেলেনি');
  return res.sendStatus(403);
});

// ---------- Webhook: মেসেজ গ্রহণ (POST) ----------
function verifySignature(req) {
  if (!APP_SECRET) return true; // APP_SECRET না দিলে যাচাই ছাড়া চলবে
  try {
    const sig = req.get('X-Hub-Signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch (_e) { return false; }
}

app.post('/webhook', (req, res) => {
  if (!verifySignature(req)) {
    console.error('Signature যাচাই ব্যর্থ');
    return res.sendStatus(403);
  }
  const body = req.body;
  if (body.object !== 'page') return res.sendStatus(404);

  // Meta-কে তাড়াতাড়ি 200 দেওয়া — উত্তর পরে পাঠানো হবে
  res.status(200).send('EVENT_RECEIVED');

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      handleEvent(event).catch(e => console.error('ইভেন্ট হ্যান্ডলে এরর:', e));
    }
    // Page feed ইভেন্ট (কমেন্ট ইত্যাদি) — feed সাবস্ক্রিপশন থাকলে আসে
    for (const change of entry.changes || []) {
      if (change.field === 'feed') {
        handleComment(change.value).catch(e => console.error('কমেন্ট হ্যান্ডলে এরর:', e));
      }
    }
  }
});

// ---------- হাতে পোস্ট করানো (বাইরের cron সার্ভিস যেমন cron-job.org থেকে ডাকা যায়) ----------
// POST_NOW_TOKEN বসানো থাকলে ?token=... (বা x-post-token হেডার) মিলতেই হবে, নাহলে 403।
app.post('/post-now', async (req, res) => {
  if (POST_NOW_TOKEN) {
    const token = req.query.token || req.get('x-post-token') || '';
    if (token !== POST_NOW_TOKEN) return res.status(403).json({ ok: false, reason: 'forbidden' });
  }
  const result = await runPostCycle('manual /post-now');
  if (result.posted) return res.json({ ok: true, posted: true, post_id: result.postId });
  return res.json({ ok: false, posted: false, reason: result.reason });
});

// ---------- স্বাস্থ্য পরীক্ষা ----------
app.get('/', (_req, res) => {
  const now = getDhakaNow();
  const postsToday = postState.posts.filter(p => {
    const d = new Date(p.ts + 6 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` === now.date;
  }).length;
  res.json({
    status: 'ok',
    test_mode: TEST_MODE,
    has_gemini_key: !!GEMINI_API_KEY,
    posts: { enabled: POST_ENABLED !== '0', slots: POST_SLOTS, posts_today: postsToday, dhaka_time: `${now.date} ${now.time}` },
  });
});

app.listen(PORT, () => {
  console.log(`Messenger Page Bot চলছে: http://localhost:${PORT}`);
  console.log(`TEST_MODE=${TEST_MODE ? 'ON (আসল মেসেজ যাবে না)' : 'OFF'}`);
  if (!GEMINI_API_KEY) console.log('সতর্কতা: GEMINI_API_KEY নেই — fallback উত্তর দেওয়া হবে');
  if (!PAGE_ACCESS_TOKEN && !TEST_MODE) console.log('সতর্কতা: PAGE_ACCESS_TOKEN নেই — মেসেজ পাঠানো যাবে না');
  // অটো পোস্ট শিডিউলার চালু (Render ফ্রি টিয়ারে ঘুমের সীমা README-তে লেখা আছে)
  if (POST_ENABLED === '0') {
    console.log('অটো পোস্ট বন্ধ (POST_ENABLED=0) — /post-now দিয়ে হাতে পোস্ট করানো যাবে');
  } else if (POST_SLOTS.length === 0) {
    console.log('সতর্কতা: POST_TIMES-এ একটাও বৈধ সময় নেই — শিডিউলার চলবে না');
  } else {
    console.log(`অটো পোস্ট শিডিউলার চালু: দিনে ${POST_SLOTS.length}টি (${POST_SLOTS.join(', ')}, ঢাকা সময়)`);
    setTimeout(() => checkScheduler().catch(e => console.error('শিডিউলার এরর:', e)), 5000);
    setInterval(() => checkScheduler().catch(e => console.error('শিডিউলার এরর:', e)), 60 * 1000);
  }
});
