// post-reel-fb.mjs — Post fail mp4 ke Facebook sebagai REEL, lepas itu buang fail.
//
// Guna:
//   node scripts/post-reel-fb.mjs --file reel.mp4 --desc "Caption #berita"
//   node scripts/post-reel-fb.mjs --file reel.mp4 --keep      # jangan buang
//
// Perlu env: FACEBOOK_PAGE_ID, FACEBOOK_PAGE_TOKEN.
// API rujukan: Page Video Reels (upload_phase start -> rupload -> finish).

import { readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GV = 'v21.0';

for (const f of ['.env.local', '.env']) {
  try {
    const txt = await readFile(path.join(__dirname, '..', f), 'utf8');
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {}
}

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}

const file = arg('file');
const desc = arg('desc', '');
const title = arg('title', '');
const comment = arg('comment', ''); // komen pertama (ringkasan + link)
const keep = process.argv.includes('--keep');

if (!file) { console.error('Perlu --file <reel.mp4>'); process.exit(1); }
const PAGE_ID = process.env.FACEBOOK_PAGE_ID;
const TOKEN = process.env.FACEBOOK_PAGE_TOKEN;
if (!PAGE_ID || !TOKEN) { console.error('FACEBOOK_PAGE_ID / FACEBOOK_PAGE_TOKEN tiada'); process.exit(1); }

const filePath = path.resolve(file);
const { size } = await stat(filePath);

async function fbJson(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`FB ${r.status}: ${JSON.stringify(j.error || j)}`);
  return j;
}

try {
  // 1) START — dapatkan video_id + upload_url
  console.log('• [1/3] Mula sesi upload reel…');
  const start = await fbJson(
    `https://graph.facebook.com/${GV}/${PAGE_ID}/video_reels`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_phase: 'start', access_token: TOKEN }) }
  );
  const { video_id, upload_url } = start;
  console.log(`  video_id=${video_id}`);

  // 2) UPLOAD — hantar bait video ke rupload (perlu Content-Length + X-Entity-Length)
  console.log(`• [2/3] Muat naik video (${(size / 1e6).toFixed(2)} MB)…`);
  const bytes = await readFile(filePath);
  await fbJson(upload_url, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${TOKEN}`,
      offset: '0',
      file_size: String(size),
      'Content-Length': String(size),
      'X-Entity-Length': String(size),
      'X-Entity-Name': path.basename(filePath),
      'X-Entity-Type': 'video/mp4',
      'Content-Type': 'application/octet-stream',
    },
    body: bytes,
  });

  // 3) FINISH — terbitkan
  console.log('• [3/3] Terbitkan/Jadualkan reel…');
  const finishUrl = new URL(`https://graph.facebook.com/${GV}/${PAGE_ID}/video_reels`);
  finishUrl.searchParams.set('access_token', TOKEN);
  finishUrl.searchParams.set('video_id', video_id);
  finishUrl.searchParams.set('upload_phase', 'finish');
  
  const isDraft = process.argv.includes('--draft');
  const scheduleTime = arg('schedule');
  
  if (scheduleTime) {
    finishUrl.searchParams.set('video_state', 'SCHEDULED');
    finishUrl.searchParams.set('scheduled_publish_time', scheduleTime);
  } else {
    finishUrl.searchParams.set('video_state', isDraft ? 'DRAFT' : 'PUBLISHED');
  }
  
  if (desc) finishUrl.searchParams.set('description', desc);
  if (title) finishUrl.searchParams.set('title', title);
  const fin = await fbJson(finishUrl.toString(), { method: 'POST' });
  console.log(`✓ Reel diterbitkan. ${JSON.stringify(fin)}`);

  // 3b) KOMEN PERTAMA — ringkasan + link berita penuh.
  if (comment) {
    // Reel perlu masa proses; cuba komen dengan beberapa percubaan.
    let ok = false;
    for (let i = 0; i < 6 && !ok; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 8000 : 10000));
      try {
        const c = await fbJson(`https://graph.facebook.com/${GV}/${video_id}/comments`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: comment, access_token: TOKEN }),
        });
        console.log(`✓ Komen pertama diletak. ${JSON.stringify(c)}`);
        ok = true;
      } catch (e) {
        // Kebenaran tiada -> tak guna cuba lagi, berhenti terus.
        if (/pages_manage_engagement|#200|not available/.test(e.message)) {
          console.warn('⚠️  Token tiada kebenaran pages_manage_engagement — komen dilangkau.');
          break;
        }
        console.log(`  …reel belum siap proses (cuba ${i + 1}/6): ${e.message}`);
      }
    }
    if (!ok) console.warn('⚠️  Komen gagal diletak (reel mungkin masih diproses). Letak manual.');
  }

  // 4) BUANG fail
  if (!keep) {
    await unlink(filePath);
    console.log(`🗑️  Fail dibuang: ${file}`);
    const jsonPath = filePath.replace(/\.mp4$/, '.json');
    try {
      await unlink(jsonPath);
      console.log(`🗑️  Fail sidecar dibuang: ${jsonPath}`);
    } catch {}
  }
} catch (e) {
  console.error('✗ Gagal post reel:', e.message);
  console.error('   (Fail TIDAK dibuang kerana gagal.)');
  process.exit(1);
}
