// লোকাল টেস্ট — Meta ছাড়াই webhook সিমুলেট করে বটের উত্তর দেখা যাবে।
// চালানো: node test-local.js
// (GEMINI_API_KEY .env-এ থাকলে আসল Gemini উত্তর আসবে, না থাকলে fallback উত্তর আসবে।)

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const OUTBOX = path.join(__dirname, 'outbox.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitUp(tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(BASE + '/');
      if (res.ok) return true;
    } catch (_e) {}
    await sleep(500);
  }
  return false;
}

function postEvent(psid, message) {
  return fetch(BASE + '/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'page',
      entry: [{ id: 'test-page', time: Date.now(), messaging: [{ sender: { id: psid }, recipient: { id: 'test-page' }, timestamp: Date.now(), message }] }],
    }),
  });
}

async function main() {
  // পুরনো আউটবক্স মুছে নতুন করে শুরু
  try { fs.unlinkSync(OUTBOX); } catch (_e) {}
  try { fs.unlinkSync(path.join(__dirname, 'memory.json')); } catch (_e) {}

  const env = {
    ...process.env,
    PORT: String(PORT),
    VERIFY_TOKEN: 'test-token',
    PAGE_ACCESS_TOKEN: 'test-token',
    TEST_MODE: '1',
  };
  const server = spawn('node', ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d.toString(); });
  server.stderr.on('data', d => { serverLog += d.toString(); });

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  try {
    if (!await waitUp()) {
      console.log('❌ সার্ভার চালু হলো না। লগ:\n' + serverLog);
      process.exit(1);
    }
    check('সার্ভার চালু', true);

    // ১) Webhook যাচাই — সঠিক token
    const okRes = await fetch(BASE + '/webhook?hub.mode=subscribe&hub.verify_token=test-token&hub.challenge=CHALLENGE123');
    check('Webhook যাচাই (সঠিক token)', okRes.status === 200 && (await okRes.text()) === 'CHALLENGE123');

    // ২) Webhook যাচাই — ভুল token → 403
    const badRes = await fetch(BASE + '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x');
    check('Webhook যাচাই (ভুল token → 403)', badRes.status === 403);

    // ৩) বাংলা প্রথম মেসেজ (greeting সহ উত্তর আসবে)
    await postEvent('111', { mid: 'm1', text: 'হাই, কেমন আছো?' });
    await sleep(1500);

    // ৪) স্মৃতি পরীক্ষা — একই লোকের পরের মেসেজ
    await postEvent('111', { mid: 'm2', text: 'আমার নাম সাকিব' });
    await sleep(1500);
    await postEvent('111', { mid: 'm3', text: 'আমার নাম কী?' });
    await sleep(1500);

    // ৫) পরিচয় প্রশ্ন — সরাসরি সৎ উত্তর আসতেই হবে
    await postEvent('222', { mid: 'm4', text: 'are you human?' });
    await sleep(1500);
    await postEvent('333', { mid: 'm5', text: 'তুমি কি মানুষ?' });
    await sleep(1500);

    // ৬) ছবি পাঠালে ভদ্র উত্তর
    await postEvent('444', { mid: 'm6', attachments: [{ type: 'image', payload: { url: 'https://example.com/pic.jpg' } }] });
    await sleep(1500);

    // আউটবক্স পড়ে উত্তরগুলো দেখানো
    let outbox = [];
    try { outbox = JSON.parse(fs.readFileSync(OUTBOX, 'utf8')); } catch (_e) {}
    const texts = outbox.filter(o => o.message?.text).map(o => ({ to: o.recipient.id, text: o.message.text }));
    const typingCount = outbox.filter(o => o.sender_action === 'typing_on').length;
    console.log('\n--- বটের উত্তর (outbox.json) ---');
    texts.forEach(t => console.log(`[${t.to}] ${t.text}`));
    console.log(`typing indicator পাঠানো হয়েছে: ${typingCount} বার`);

    check('টেক্সট মেসেজের উত্তর এসেছে', texts.length >= 5, `${texts.length}টি উত্তর`);
    check('typing indicator দেওয়া হয়েছে', typingCount >= 5, `${typingCount} বার`);
    const idEn = texts.find(t => t.to === '222');
    check('"are you human?"-এর সৎ উত্তর', !!idEn && /not a human/i.test(idEn.text), idEn?.text);
    const idBn = texts.find(t => t.to === '333');
    check('"তুমি কি মানুষ?"-এর সৎ উত্তর', !!idBn && /মানুষ নই/.test(idBn.text), idBn?.text);
    const first = texts.find(t => t.to === '111');
    check('প্রথম মেসেজে greeting', !!first && /হাই|AI বন্ধু/.test(first.text), first?.text);
    const img = texts.find(t => t.to === '444');
    check('ছবিতে ভদ্র উত্তর', !!img, img?.text);

    if (!process.env.GEMINI_API_KEY) {
      console.log('\nℹ️ GEMINI_API_KEY নেই বলে উপরের উত্তরগুলো fallback — আসল Gemini উত্তর দেখতে .env-এ key বসিয়ে আবার চালাও (পরিচয়-উত্তর আর ছবির উত্তর এমনিতেই আসল)।');
    }
  } finally {
    server.kill();
    await sleep(500);
  }

  // ============ বহুভাষিক পরীক্ষা (stub Gemini — ভাষা-সচেতন) ============
  // সার্ভার 2: stub চালু, TEST_STUB_TEXT নেই — stub মেসেজের ভাষা অনুযায়ী উত্তর দেবে।
  try { fs.unlinkSync(OUTBOX); } catch (_e) {}
  const env2 = {
    ...process.env,
    PORT: '3105',
    VERIFY_TOKEN: 'test-token',
    PAGE_ACCESS_TOKEN: 'test-token',
    TEST_MODE: '1',
    TEST_STUB_GEMINI: '1',
  };
  const server2 = spawn('node', ['server.js'], { cwd: __dirname, env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
  let server2Log = '';
  server2.stdout.on('data', d => { server2Log += d.toString(); });
  server2.stderr.on('data', d => { server2Log += d.toString(); });
  const BASE2 = 'http://localhost:3105';
  try {
    let up2 = false;
    for (let i = 0; i < 30; i++) {
      try { const r = await fetch(BASE2 + '/'); if (r.ok) { up2 = true; break; } } catch (_e) {}
      await sleep(500);
    }
    check('বহুভাষিক সার্ভার চালু', up2);
    if (up2) {
      const postTo2 = (psid, message) => fetch(BASE2 + '/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          object: 'page',
          entry: [{ id: 'test-page', time: Date.now(), messaging: [{ sender: { id: psid }, recipient: { id: 'test-page' }, timestamp: Date.now(), message }] }],
        }),
      });
      await postTo2('555', { mid: 'm10', text: 'হাই, কেমন আছো?' });
      await postTo2('556', { mid: 'm11', text: 'Hi, how are you?' });
      await postTo2('557', { mid: 'm12', text: 'नमस्ते, कैसे हो?' });
      await postTo2('558', { mid: 'm13', text: 'Halo, apa kabar?' });
      await postTo2('559', { mid: 'm14', text: 'क्या तुम इंसान हो?' });
      await postTo2('560', { mid: 'm15', text: 'Apakah kamu manusia?' });
      await sleep(3000);
      let outbox2 = [];
      try { outbox2 = JSON.parse(fs.readFileSync(OUTBOX, 'utf8')); } catch (_e) {}
      const texts2 = outbox2.filter(o => o.message?.text).map(o => ({ to: o.recipient.id, text: o.message.text }));
      const replyOf = id => texts2.find(t => t.to === id)?.text || '';
      check('বাংলা মেসেজে বাংলা উত্তর', /[\u0980-\u09FF]/.test(replyOf('555')), replyOf('555'));
      check('ইংরেজি মেসেজে ইংরেজি উত্তর', /that is great/i.test(replyOf('556')), replyOf('556'));
      check('হিন্দি মেসেজে হিন্দি উত্তর', /[\u0900-\u097F]/.test(replyOf('557')), replyOf('557'));
      check('ইন্দোনেশিয়ান মেসেজে ইন্দোনেশিয়ান উত্তর', /itu bagus sekali/i.test(replyOf('558')), replyOf('558'));
      check('হিন্দিতে "তুমি কি মানুষ?"-এর সৎ উত্তর', /ओलिविया/.test(replyOf('559')) && /इंसान नहीं/.test(replyOf('559')), replyOf('559'));
      check('ইন্দোনেশিয়ানে "তুমি কি মানুষ?"-এর সৎ উত্তর', /Olivia/.test(replyOf('560')) && /bukan manusia/i.test(replyOf('560')), replyOf('560'));
    }
  } finally {
    server2.kill();
    await sleep(500);
  }

  const failed = results.filter(r => !r.ok).length;
  console.log(`\nফলাফল: ${results.length - failed}/${results.length} পাস`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('টেস্টে এরর:', e); process.exit(1); });
