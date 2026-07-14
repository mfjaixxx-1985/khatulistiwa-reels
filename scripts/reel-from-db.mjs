// reel-from-db.mjs — Ambil artikel dari Supabase dan jana Reel 9:16 automatik.
//
// Guna:
//   node scripts/reel-from-db.mjs                 # artikel published terbaru (ada gambar)
//   node scripts/reel-from-db.mjs --slug <slug>   # artikel tertentu
//   node scripts/reel-from-db.mjs --lang ms --dur 15 --music none
//
// Bahan diambil terus: title, summary, imageUrl. Tiada taip manual.

import { createClient } from '@supabase/supabase-js';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- muat .env (corak sama macam scripts lain) ----------
for (const f of ['.env.local', '.env']) {
  try {
    const txt = await readFile(path.join(__dirname, '..', f), 'utf8');
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch { /* fail opsyenal */ }
}

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY tiada dalam .env');
  process.exit(1);
}
const supabase = createClient(url, key);

const LOCALES = ['en', 'ms', 'id', 'es', 'pt', 'ar'];
const slug = arg('slug');
// --lang xx : paksa bahasa tertentu. Default: RAWAK antara bahasa yg ada.
const langArg = arg('lang', 'random');

const SEL = 'id, title, slug, summary, tldr, imageUrl, lang, publishedAt, ArticleTranslation(locale, title, summary)';
const pickRandom = process.argv.includes('--random-article');

let a;
if (slug) {
  const { data, error } = await supabase.from('Article').select(SEL).eq('slug', slug).limit(1);
  if (error) { console.error('Ralat Supabase:', error.message); process.exit(1); }
  a = data?.[0];
} else if (pickRandom) {
  // Ambil kolam id artikel published (ada gambar), pilih satu secara rawak.
  const pool = await supabase.from('Article').select('id')
    .eq('status', 'published').not('imageUrl', 'is', null)
    .order('publishedAt', { ascending: false }).limit(1000);
  if (pool.error) { console.error('Ralat Supabase:', pool.error.message); process.exit(1); }
  if (!pool.data?.length) { console.error('Tiada artikel.'); process.exit(1); }
  const pid = pool.data[Math.floor(Math.random() * pool.data.length)].id;
  const { data } = await supabase.from('Article').select(SEL).eq('id', pid).limit(1);
  a = data?.[0];
} else {
  const { data, error } = await supabase.from('Article').select(SEL)
    .eq('status', 'published').not('imageUrl', 'is', null)
    .order('publishedAt', { ascending: false }).limit(1);
  if (error) { console.error('Ralat Supabase:', error.message); process.exit(1); }
  a = data?.[0];
}
if (!a) { console.error('Tiada artikel published dengan gambar dijumpai.'); process.exit(1); }

// Kumpul versi bahasa: asal + semua terjemahan yang ada.
const versions = { [a.lang]: { title: a.title, summary: a.summary } };
for (const t of a.ArticleTranslation || []) {
  if (LOCALES.includes(t.locale)) versions[t.locale] = { title: t.title, summary: t.summary };
}
const available = Object.keys(versions);

let chosen;
if (langArg === 'random') {
  chosen = available[Math.floor(Math.random() * available.length)];
} else if (versions[langArg]) {
  chosen = langArg;
} else {
  console.error(`❌ Ralat: Bahasa "${langArg}" tidak ditemui untuk artikel ini.`);
  process.exit(1);
}

const v = versions[chosen];
console.log(`• Bahasa dipilih: ${chosen.toUpperCase()}  (ada: ${available.join(', ')})`);
console.log(`• Artikel: "${v.title}"\n• Gambar: ${a.imageUrl}`);

const out = arg('out', `reel-${chosen}-${a.slug}.mp4`);
const dur = arg('dur', '30');
const music = arg('music'); // teruskan apa adanya (default-handling di make-reel)

// URL artikel (en = tiada prefix locale; lain ada).
const SITE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://khatulistiwa.org').replace(/\/$/, '');
const articleUrl = chosen === 'en' ? `${SITE}/berita/${a.slug}` : `${SITE}/${chosen}/berita/${a.slug}`;

// Frasa "baca penuh" untuk komen pertama, ikut bahasa.
const READ = {
  en: 'Read the full story', ms: 'Baca berita penuh', id: 'Baca selengkapnya',
  es: 'Lee la noticia completa', pt: 'Leia a notícia completa', ar: 'اقرأ الخبر كاملاً',
};
const caption = `${v.title}\n\n👉 ${READ[chosen] || READ.ms}: ${articleUrl}`;
const comment = `${v.summary || v.title}\n\n👉 ${READ[chosen] || READ.ms}: ${articleUrl}`;

// Tulis sidecar supaya langkah post boleh guna caption + komen yang betul.
await (await import('node:fs/promises')).writeFile(
  out.replace(/\.mp4$/, '') + '.json',
  JSON.stringify({ file: out, lang: chosen, url: articleUrl, caption, comment }, null, 2)
);

const args = [
  path.join(__dirname, 'make-reel.mjs'),
  '--image', a.imageUrl,
  '--title', v.title,
  '--summary', v.summary || '',
  '--lang', chosen,
  '--out', out,
  '--dur', dur,
];
if (a.tldr && chosen === a.lang) args.push('--tldr', a.tldr);
if (music) args.push('--music', music);
if (process.argv.includes('--wide')) args.push('--wide');
if (process.argv.includes('--horizontal')) args.push('--horizontal');

const p = spawn('node', args, { stdio: 'inherit' });
p.on('close', async (code) => {
  if (code) process.exit(code);
  console.log(`\n• Caption: ${caption}`);
  console.log(`• Komen-1: ${comment.replace(/\n/g, ' ')}`);
  console.log(`• Sidecar: ${out.replace(/\.mp4$/, '')}.json`);

  const postFb = process.argv.includes('--post-fb') || process.argv.includes('--post');
  const postBsky = process.argv.includes('--post-bsky');

  if (postFb || postBsky) {
    console.log('\n• Menerbitkan ke platform sosial…');
    const isDraft = process.argv.includes('--draft');
    const scheduleTime = arg('schedule');
    
    // A. Kredensial untuk Facebook
    const runPostFb = () => new Promise((resolve) => {
      if (!postFb) {
        resolve(true);
        return;
      }
      console.log('\n• Menghantar ke Facebook...');
      const ppArgs = [
        path.join(__dirname, 'post-reel-fb.mjs'),
        '--file', out, '--desc', caption, '--title', v.title, '--comment', comment,
      ];
      if (scheduleTime) {
        ppArgs.push('--schedule', scheduleTime);
      } else if (isDraft) {
        ppArgs.push('--draft');
      }
      const pp = spawn('node', ppArgs, { stdio: 'inherit' });
      pp.on('close', async (c) => {
        if (c === 0 && a?.id) {
          console.log(`\n• Mendaftarkan rekod SocialPost Facebook untuk artikel ID: ${a.id}...`);
          const { error } = await supabase.from('SocialPost').insert({
            id: crypto.randomUUID(),
            articleId: a.id,
            channel: 'facebook_reel',
            status: 'sent',
          });
          if (error) console.error('❌ Gagal menulis rekod SocialPost Facebook:', error.message);
        }
        resolve(c === 0);
      });
    });
    
    // B. Kredensial untuk Bluesky
    const handle = process.env.BLUESKY_HANDLE;
    const password = process.env.BLUESKY_APP_PASSWORD;
    
    const runPostBsky = () => new Promise((resolve) => {
      if (!postBsky) {
        resolve(true);
        return;
      }
      if (!handle || !password) {
        console.warn('⚠️ BLUESKY_HANDLE atau BLUESKY_APP_PASSWORD tiada dalam .env. Langkau.');
        resolve(true);
        return;
      }
      console.log('\n• Menghantar ke Bluesky...');
      const bskyArgs = [
        path.join(__dirname, 'post-reel-bsky.mjs'),
        '--file', out,
        '--desc', v.title,
        '--comment', comment,
        '--lang', chosen
      ];
      const pp = spawn('node', bskyArgs, { stdio: 'inherit' });
      pp.on('close', async (c) => {
        if (c === 0 && a?.id) {
          console.log(`\n• Mendaftarkan rekod SocialPost Bluesky untuk artikel ID: ${a.id}...`);
          const { error } = await supabase.from('SocialPost').insert({
            id: crypto.randomUUID(),
            articleId: a.id,
            channel: 'bluesky_video',
            status: 'sent',
          });
          if (error) console.error('❌ Gagal menulis rekod SocialPost Bluesky:', error.message);
        }
        resolve(c === 0);
      });
    });

    // Jalankan berturutan
    const fbOk = await runPostFb();
    const bskyOk = await runPostBsky();
    
    process.exit((fbOk && bskyOk) ? 0 : 1);
  } else {
    process.exit(0);
  }
});
