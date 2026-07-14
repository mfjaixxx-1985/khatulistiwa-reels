// post-reel-bsky.mjs — Muat naik fail mp4 ke Bluesky sebagai Video Post.
//
// Guna:
//   node scripts/post-reel-bsky.mjs --file reel.mp4 --desc "Caption #berita" --lang ms
//
// Perlu env: BLUESKY_HANDLE, BLUESKY_APP_PASSWORD.

import { readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Muat fail persekitaran .env ----------
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

async function bskyCall(url, options = {}) {
  const res = await fetch(url, options);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.message || `HTTP Error ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function parseFacets(text) {
  if (!text) return undefined;
  const facets = [];
  const urlRegex = /https?:\/\/[^\s\)]+/g;
  let match;
  const encoder = new TextEncoder();
  while ((match = urlRegex.exec(text)) !== null) {
    const url = match[0];
    const charStart = match.index;
    const byteStart = encoder.encode(text.slice(0, charStart)).length;
    const byteEnd = byteStart + encoder.encode(url).length;
    facets.push({
      index: {
        byteStart,
        byteEnd
      },
      features: [
        {
          $type: 'app.bsky.richtext.facet#link',
          uri: url
        }
      ]
    });
  }
  return facets.length > 0 ? facets : undefined;
}

function truncateBlueskyPost(text, limit = 300) {
  if (!text || text.length <= limit) return text;

  const urlRegex = /(https?:\/\/[^\s\)]+)/g;
  const urls = [...text.matchAll(urlRegex)];

  if (urls.length > 0) {
    const lastUrlMatch = urls[urls.length - 1];
    const url = lastUrlMatch[0];
    const urlIndex = lastUrlMatch.index;

    const prefix = text.slice(0, urlIndex);
    const suffix = text.slice(urlIndex);

    const allowedPrefixLen = limit - suffix.length - 4;
    if (allowedPrefixLen > 0) {
      const truncatedPrefix = prefix.slice(0, allowedPrefixLen).trimEnd() + '... ';
      return truncatedPrefix + suffix;
    } else {
      return suffix.slice(0, limit);
    }
  }

  return text.slice(0, limit - 3).trimEnd() + '...';
}

async function main() {
  const filePath = arg('file');
  const desc = arg('desc', '');
  const lang = arg('lang', 'ms');
  const commentText = arg('comment');
  const keep = process.argv.includes('--keep');

  if (!filePath) {
    console.error('❌ Ralat: Sila nyatakan fail video menggunakan --file <path>');
    process.exit(1);
  }

  const HANDLE = process.env.BLUESKY_HANDLE;
  const PASSWORD = process.env.BLUESKY_APP_PASSWORD;

  if (!HANDLE || !PASSWORD) {
    console.error('⚠️  BLUESKY_HANDLE atau BLUESKY_APP_PASSWORD tiada dalam .env. Langkau post Bluesky.');
    process.exit(0);
  }

  try {
    console.log(`• Membaca fail video: ${filePath}...`);
    const bytes = await readFile(filePath);
    const size = bytes.length;

    // 1. Cipta Sesi (Authentication)
    console.log('• [1/5] Log masuk ke Bluesky...');
    const session = await bskyCall('https://bsky.social/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: HANDLE, password: PASSWORD })
    });
    const { accessJwt, did } = session;
    console.log(`✓ Log masuk berjaya. DID: ${did}`);

    // 2. Dapatkan Token Kebenaran Servis Video (Service Auth Token)
    console.log('• [2/5] Meminta token kebenaran video service...');
    let pdsDid = 'did:web:phellinus.us-west.host.bsky.network'; // fallback
    try {
      const parts = accessJwt.split('.');
      if (parts[1]) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        if (payload.aud) {
          pdsDid = payload.aud;
        }
      }
    } catch (e) {
      console.warn('⚠️ Gagal mengekstrak PDS DID dari accessJwt:', e.message);
    }

    const queryParams = new URLSearchParams({
      aud: pdsDid,
      lxm: 'com.atproto.repo.uploadBlob',
      exp: String(Math.floor(Date.now() / 1000) + 1800)
    });
    const serviceAuth = await bskyCall(`https://bsky.social/xrpc/com.atproto.server.getServiceAuth?${queryParams.toString()}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessJwt}`
      }
    });
    const videoToken = serviceAuth.token;
    console.log('✓ Token video service diperoleh.');

    // 3. Muat Naik Video Binary ke Video Service
    console.log(`• [3/5] Memuat naik video ke Bluesky Video Service (${(size / (1024 * 1024)).toFixed(2)} MB)...`);
    const uploadParams = new URLSearchParams({
      did: did,
      name: path.basename(filePath)
    });
    const uploadRes = await bskyCall(`https://video.bsky.app/xrpc/app.bsky.video.uploadVideo?${uploadParams.toString()}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${videoToken}`,
        'Content-Type': 'video/mp4',
        'Content-Length': String(size)
      },
      body: bytes
    });
    const jobId = uploadRes.jobId || uploadRes.jobStatus?.jobId;
    if (!jobId) {
      throw new Error(`Gagal mendapat Job ID dari muat naik video: ${JSON.stringify(uploadRes)}`);
    }
    console.log(`✓ Video dihantar. Job ID: ${jobId}`);

    // 4. Poll status pemprosesan video
    console.log('• [4/5] Menunggu pemprosesan video selesai (polling)...');
    let blobRef = null;
    for (let attempt = 1; attempt <= 40; attempt++) {
      await new Promise((r) => setTimeout(r, 5000));
      const statusRes = await bskyCall(`https://video.bsky.app/xrpc/app.bsky.video.getJobStatus?jobId=${encodeURIComponent(jobId)}`, {
        headers: { 'Authorization': `Bearer ${videoToken}` }
      });
      const job = statusRes.jobStatus || statusRes;
      const state = job.state;
      console.log(`  [Percubaan ${attempt}] Status pemprosesan: ${state}`);

      if (state === 'SUCCESS' || state === 'JOB_STATE_COMPLETED') {
        blobRef = job.blob;
        break;
      } else if (state === 'FAILED' || state === 'JOB_STATE_FAILED') {
        throw new Error(`Pemprosesan video gagal di Bluesky: ${job.error}`);
      }
    }

    if (!blobRef) {
      throw new Error('Timeout: Pemprosesan video mengambil masa terlalu lama di Bluesky.');
    }
    console.log('✓ Pemprosesan video selesai!');

    // 5. Cipta Post dengan Video Embed
    console.log('• [5/5] Menerbitkan post video ke suapan Bluesky...');
    const truncatedDesc = truncateBlueskyPost(desc, 300);
    const record = {
      $type: 'app.bsky.feed.post',
      text: truncatedDesc,
      facets: parseFacets(truncatedDesc),
      createdAt: new Date().toISOString(),
      langs: [lang],
      embed: {
        $type: 'app.bsky.embed.video',
        video: blobRef,
        aspectRatio: {
          width: 1080,
          height: 1920
        }
      }
    };

    const postRes = await bskyCall('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessJwt}`
      },
      body: JSON.stringify({
        repo: did,
        collection: 'app.bsky.feed.post',
        record
      })
    });
    
    console.log(`✓ Video berjaya disiarkan di Bluesky! URI: ${postRes.uri}`);

    if (commentText) {
      console.log('• Menulis komen pertama (reply thread) di Bluesky...');
      const truncatedComment = truncateBlueskyPost(commentText, 300);
      const replyRecord = {
        $type: 'app.bsky.feed.post',
        text: truncatedComment,
        facets: parseFacets(truncatedComment),
        createdAt: new Date().toISOString(),
        langs: [lang],
        reply: {
          root: { uri: postRes.uri, cid: postRes.cid },
          parent: { uri: postRes.uri, cid: postRes.cid }
        }
      };
      const replyRes = await bskyCall('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessJwt}`
        },
        body: JSON.stringify({
          repo: did,
          collection: 'app.bsky.feed.post',
          record: replyRecord
        })
      });
      console.log(`✓ Komen pertama berjaya disiarkan! URI: ${replyRes.uri}`);
    }

    // 6. Buang fail jika keep tiada
    if (!keep) {
      await unlink(filePath);
      console.log(`🗑️  Fail dibuang: ${filePath}`);
      const jsonPath = filePath.replace(/\.mp4$/, '.json');
      try {
        await unlink(jsonPath);
        console.log(`🗑️  Fail sidecar dibuang: ${jsonPath}`);
      } catch {}
    }
  } catch (err) {
    console.error('❌ Gagal memuat naik video ke Bluesky:', err.message);
    process.exit(1);
  }
}

main();
