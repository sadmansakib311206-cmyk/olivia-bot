// অটো পোস্ট + কমেন্ট উত্তরের লোকাল টেস্ট — Meta ছাড়াই।
// চালানো: node test-posts.js   (মোট ~২ মিনিট — শিডিউলার পরীক্ষায় ~৮০ সেকেন্ড অপেক্ষা আছে)
// (GEMINI_API_KEY থাকলে আসল Gemini উত্তর আসবে; না থাকলে TEST_STUB_GEMINI দিয়ে stub উত্তর পরীক্ষা হয়।)

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUTBOX = path.join(__dirname, 'outbox.json');
const POSTS = path.join(__dirname, 'posts.json');
const REPLIES = path.join(__dirname, 'comment-replies.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function cleanState() {
  for (const f of [OUTBOX, POSTS, REPLIES]) {
    try { fs.unlinkSync(f); } catch (_e) {}
  }
}

function readOutbox() {
  try { return JSON.parse(fs.readFileSync(OUTBOX, 'utf8')); } catch (_e) { return []; }
}

function readPosts() {
  try { return JSON.parse(fs.readFileSync(POSTS, 'utf8')); } catch (_e) { return { postedSlots: {}, posts: [] }; }
}

async function waitUp(base, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(base + '/');
      if (res.ok) return true;
    } catch (_e) {}
    await sleep(500);
  }
  return false;
}

function startServer(port, extraEnv) {
  const env = {
    ...process.env,
    PORT: String(port),
    VERIFY_TOKEN: 'test-token',
    PAGE_ACCESS_TOKEN: 'test-token',
    PAGE_ID: 'test-page',
    TEST_MODE: '1',
    ...extraEnv,
  };
  const server = spawn('node', ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', d => { log += d.toString(); });
  server.stderr.on('data', d => { log += d.toString(); });
  return { server, getLog: () => log };
}

async function stopServer(s) {
  s.server.kill();
  await sleep(500);
}

function postComment(base, value) {
  return fetch(base + '/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'page',
      entry: [{ id: 'test-page', time: Date.now(), changes: [{ field: 'feed', value }] }],
    }),
  });
}

async function main() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  // ============ সার্ভার A: key নেই, POST_NOW_TOKEN আছে, শিডিউলার বন্ধ ============
  cleanState();
  const A = startServer(3101, { POST_ENABLED: '0', POST_NOW_TOKEN: 'secret123' });
  try {
    if (!await waitUp('http://localhost:3101')) {
      console.log('❌ সার্ভার A চালু হলো না। লগ:\n' + A.getLog());
      process.exit(1);
    }
    check('সার্ভার A চালু', true);

    const health = await (await fetch('http://localhost:3101/')).json();
    check('Health-এ পোস্ট বন্ধ দেখায় (POST_ENABLED=0)', health.posts && health.posts.enabled === false);

    // ১) /post-now টোকেন ছাড়া → 403
    const noToken = await fetch('http://localhost:3101/post-now', { method: 'POST' });
    check('/post-now টোকেন ছাড়া → 403', noToken.status === 403);

    // ২) /post-now টোকেনসহ, কিন্তু Gemini key নেই → পোস্ট হবে না, কারণ স্পষ্ট
    const noKey = await fetch('http://localhost:3101/post-now?token=secret123', { method: 'POST' });
    const noKeyBody = await noKey.json();
    check('/post-now key ছাড়া পোস্ট করে না', noKey.ok && noKeyBody.posted === false && noKeyBody.reason === 'no_gemini_key', JSON.stringify(noKeyBody));
    await sleep(500);
    check('key ছাড়া outbox-এ ভুয়া পোস্ট নেই', readOutbox().filter(o => o.type === 'post').length === 0);
    check('লগে স্পষ্ট কারণ লেখা', A.getLog().includes('GEMINI_API_KEY নেই'));

    // ৩) স্প্যাম কমেন্ট (লিংক + টাকা ইনকাম) → উত্তর নয়
    await postComment('http://localhost:3101', {
      item: 'comment', verb: 'add', comment_id: 'c500', post_id: 'p1',
      sender_id: 'u500', sender_name: 'স্প্যামার', message: 'এই লিংকে ক্লিক করো http://example.com টাকা ইনকাম করো',
    });
    await sleep(1500);
    check('স্প্যাম কমেন্টে উত্তর নয়', readOutbox().filter(o => o.type === 'comment_reply').length === 0);
    check('স্প্যাম-লগ লেখা', A.getLog().includes('স্প্যাম/গালি মনে হওয়ায়'));

    // ৪) পেজের নিজের কমেন্ট → উত্তর নয়
    await postComment('http://localhost:3101', {
      item: 'comment', verb: 'add', comment_id: 'c501', post_id: 'p1',
      sender_id: 'test-page', sender_name: 'Page', message: 'ধন্যবাদ সবাইকে!',
    });
    await sleep(1500);
    check('পেজের নিজের কমেন্টে উত্তর নয়', readOutbox().filter(o => o.type === 'comment_reply').length === 0);
  } finally {
    await stopServer(A);
  }

  // ============ সার্ভার B: stub Gemini চালু (পুরো ফ্লো পরীক্ষা) ============
  cleanState();
  const B = startServer(3102, {
    POST_ENABLED: '0',
    TEST_STUB_GEMINI: '1',
    TEST_STUB_TEXT: 'পরীক্ষার মজার পোস্ট 😄',
  });
  let firstPostId = '';
  try {
    if (!await waitUp('http://localhost:3102')) {
      console.log('❌ সার্ভার B চালু হলো না। লগ:\n' + B.getLog());
      process.exit(1);
    }
    check('সার্ভার B চালু', true);

    // ৫) /post-now → পোস্ট হয়, outbox-এ যায়
    const postRes = await fetch('http://localhost:3102/post-now', { method: 'POST' });
    const postBody = await postRes.json();
    check('/post-now দিয়ে পোস্ট হয়', postRes.ok && postBody.posted === true && !!postBody.post_id, JSON.stringify(postBody));
    firstPostId = postBody.post_id || '';
    await sleep(500);
    const posts = readOutbox().filter(o => o.type === 'post');
    check('outbox-এ পোস্ট আছে', posts.length === 1 && posts[0].text === 'পরীক্ষার মজার পোস্ট 😄', posts[0]?.text);
    check('posts.json-এ পোস্ট সংরক্ষিত', readPosts().posts.length === 1);

    // ৬) একই লেখা আবার পোস্ট করতে গেলে duplicate → হয় না
    const dupRes = await fetch('http://localhost:3102/post-now', { method: 'POST' });
    const dupBody = await dupRes.json();
    check('একই পোস্ট দুবার হয় না', dupBody.posted === false && dupBody.reason === 'duplicate', JSON.stringify(dupBody));

    // ৭) সাধারণ বাংলা কমেন্ট → মজার উত্তর
    await postComment('http://localhost:3102', {
      item: 'comment', verb: 'add', comment_id: 'c200', post_id: firstPostId,
      sender_id: 'u200', sender_name: 'রহিম', message: 'হাহা দারুণ!',
    });
    await sleep(1500);
    let replies = readOutbox().filter(o => o.type === 'comment_reply');
    check('সাধারণ কমেন্টে উত্তর আসে', replies.length === 1 && replies[0].comment_id === 'c200', replies[0]?.text);

    // ৮) একই থ্রেডে আবার (parent_id = c200) → দ্বিতীয় উত্তর নয়
    await postComment('http://localhost:3102', {
      item: 'comment', verb: 'add', comment_id: 'c201', parent_id: 'c200', post_id: firstPostId,
      sender_id: 'u201', sender_name: 'করিম', message: 'আরেকটা কথা',
    });
    await sleep(1500);
    replies = readOutbox().filter(o => o.type === 'comment_reply');
    check('এক থ্রেডে ২য় উত্তর নয়', replies.length === 1);
    check('থ্রেড-লগ লেখা', B.getLog().includes('আগেই উত্তর দেওয়া হয়েছে'));

    // ৯) কমেন্টে পরিচয় প্রশ্ন → সৎ উত্তর (Gemini ছাড়াই)
    await postComment('http://localhost:3102', {
      item: 'comment', verb: 'add', comment_id: 'c300', post_id: firstPostId,
      sender_id: 'u300', sender_name: 'জিজ্ঞাসু', message: 'তুমি কি মানুষ?',
    });
    await sleep(1500);
    replies = readOutbox().filter(o => o.type === 'comment_reply');
    const idReply = replies.find(r => r.comment_id === 'c300');
    check('কমেন্টে "তুমি কি মানুষ?"-এর সৎ উত্তর', !!idReply && /মানুষ নই/.test(idReply.text), idReply?.text);

    // ১০) গালি-কমেন্ট → উত্তর নয়
    await postComment('http://localhost:3102', {
      item: 'comment', verb: 'add', comment_id: 'c400', post_id: firstPostId,
      sender_id: 'u400', sender_name: 'রাগী', message: 'তুমি একটা বোকাচোদা',
    });
    await sleep(1500);
    replies = readOutbox().filter(o => o.type === 'comment_reply');
    check('গালি-কমেন্টে উত্তর নয়', replies.length === 2, `${replies.length}টি উত্তর`);
  } finally {
    await stopServer(B);
  }

  // ============ সার্ভার C: শিডিউলার (ঢাকা সময়ে ১ মিনিট পরের স্লট) ============
  cleanState();
  const dhakaNow = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const slotDate = new Date(dhakaNow.getTime() + 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const slot = `${pad(slotDate.getUTCHours())}:${pad(slotDate.getUTCMinutes())}`;
  console.log(`\n🕐 শিডিউলার পরীক্ষা: স্লট ${slot} (ঢাকা সময়) — ~৮০ সেকেন্ড অপেক্ষা...`);
  const C = startServer(3103, {
    POST_ENABLED: '1',
    POSTS_PER_DAY: '1',
    POST_TIMES: slot,
    TEST_STUB_GEMINI: '1',
    TEST_STUB_TEXT: 'শিডিউলারের পোস্ট 😄',
  });
  try {
    if (!await waitUp('http://localhost:3103')) {
      console.log('❌ সার্ভার C চালু হলো না। লগ:\n' + C.getLog());
      process.exit(1);
    }
    check('সার্ভার C চালু', true);
    await sleep(80000);
    const schedPosts = readOutbox().filter(o => o.type === 'post');
    check('শিডিউলার সময়মতো পোস্ট করেছে', schedPosts.length === 1 && schedPosts[0].text === 'শিডিউলারের পোস্ট 😄', schedPosts[0]?.text);
    check('শিডিউলারের লগে স্লট লেখা', C.getLog().includes(`schedule ${slot}`));
  } finally {
    await stopServer(C);
  }

  const failed = results.filter(r => !r.ok).length;
  console.log(`\nফলাফল: ${results.length - failed}/${results.length} পাস`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('টেস্টে এরর:', e); process.exit(1); });
