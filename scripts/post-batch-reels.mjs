import { createClient } from '@supabase/supabase-js';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
      const i = t.indexOf('=');
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch { /* Opsyenal */ }
}

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY tiada dalam .env');
  process.exit(1);
}
const supabase = createClient(url, key);

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    console.log(`\n🚀 Menjalankan: ${cmd} ${args.join(' ')}`);
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Perintah keluar dengan kod ${code}`));
    });
  });
}

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function getNextSlots(count) {
  const slots = [];
  const now = new Date();
  
  let dayOffset = 0;
  while (slots.length < count) {
    const currentDay = new Date();
    currentDay.setDate(currentDay.getDate() + dayOffset);
    currentDay.setSeconds(0);
    currentDay.setMilliseconds(0);
    
    // Jana slot dari 7:00 AM hingga 10:00 PM (22:00) setiap 30 minit
    for (let hour = 7; hour <= 22; hour++) {
      for (const minute of [0, 30]) {
        // Had sehingga 10:00 PM sahaja (langkau 22:30)
        if (hour === 22 && minute === 30) continue;
        
        const d = new Date(currentDay);
        d.setHours(hour, minute, 0, 0);
        
        // Mesti sekurang-kurangnya 15 minit di hadapan waktu semasa
        if (d.getTime() - now.getTime() > 15 * 60 * 1000) {
          if (slots.length < count) {
            slots.push(Math.floor(d.getTime() / 1000));
          }
        }
      }
    }
    dayOffset++;
  }
  return slots;
}

async function main() {
  const limitArg = parseInt(arg('limit', '5'), 10);
  const offsetArg = parseInt(arg('offset', '0'), 10);
  const platform = arg('platform', 'fb'); // fb | bsky
  const scheduleMode = process.argv.includes('--schedule') && platform === 'fb';
  
  const channelName = platform === 'bsky' ? 'bluesky_video' : 'facebook_reel';
  const postFlag = platform === 'bsky' ? '--post-bsky' : '--post-fb';
  const langVal = platform === 'bsky' ? 'en' : 'ms';

  console.log("=== MEMULAKAN PENJANAAN REELS PUKAL (BATCH GENERATION) ===\n");
  console.log(`Platform Sasaran: ${platform.toUpperCase()}`);
  console.log(`Had Penjanaan: ${limitArg} video (Offset: ${offsetArg})`);
  if (scheduleMode) {
    console.log("💡 Automasi Penjadualan Aktif: Menyusun slot 30-minit (7:00 AM - 10:00 PM, 2 video sejam)...");
  }
  
  // 1) Dapatkan ID artikel yang telah dipost bagi mengelakkan pertindihan
  const { data: postedRecords, error: postsError } = await supabase.from('SocialPost')
    .select('articleId')
    .eq('channel', channelName);
    
  if (postsError) {
    console.error('Ralat ketika membaca rekod SocialPost:', postsError.message);
    process.exit(1);
  }
  
  const postedIds = new Set((postedRecords || []).map(p => p.articleId));
  console.log(`💡 Menjumpai ${postedIds.size} artikel yang telah dimuat naik ke ${platform.toUpperCase()} sebelumnya.`);

  // 2) Dapatkan semua artikel terbaru yang diterbitkan dan mempunyai imej
  const { data: allArticles, error } = await supabase.from('Article')
    .select('id, slug, title, lang, ArticleTranslation(locale)')
    .eq('status', 'published')
    .not('imageUrl', 'is', null)
    .order('publishedAt', { ascending: false });

  if (error) {
    console.error('Ralat ketika membaca pangkalan data:', error.message);
    process.exit(1);
  }

  // 3) Tapis artikel yang belum dipost dan pastikan ada versi bahasa yang betul
  const articles = (allArticles || [])
    .filter(art => !postedIds.has(art.id))
    .filter(art => {
      if (platform === 'bsky') {
        if (art.lang === 'en') return true;
        const translations = art.ArticleTranslation || [];
        return translations.some(t => t.locale === 'en');
      }
      if (platform === 'fb') {
        if (art.lang === 'ms') return true;
        const translations = art.ArticleTranslation || [];
        return translations.some(t => t.locale === 'ms');
      }
      return true;
    })
    .slice(offsetArg, offsetArg + limitArg);

  if (articles.length === 0) {
    console.log(`Tiada artikel baharu yang memerlukan draf/siaran di ${platform.toUpperCase()}.`);
    process.exit(0);
  }

  const scheduleTimes = scheduleMode ? getNextSlots(articles.length) : [];
  console.log(`Menjumpai ${articles.length} artikel baharu untuk dijana.`);
  
  for (let i = 0; i < articles.length; i++) {
    const art = articles[i];
    console.log(`\n[${i + 1}/${articles.length}] Memproses artikel: "${art.title}" (${langVal.toUpperCase()})`);
    
    // Guna nama fail tersendiri
    const outFilename = `batch-reel-${i + 1}.mp4`;
    
    const runArgs = [
      'tsx', 
      path.join(__dirname, 'reel-from-db.mjs'),
      '--slug', art.slug,
      '--lang', langVal,
      '--dur', '30',
      '--out', outFilename,
      postFlag,
    ];
    
    if (scheduleMode && scheduleTimes[i]) {
      const dateStr = new Date(scheduleTimes[i] * 1000).toLocaleString('ms-MY', { timeZone: 'Asia/Kuala_Lumpur' });
      console.log(`💡 Waktu jadual ditetapkan: ${dateStr}`);
      runArgs.push('--schedule', String(scheduleTimes[i]));
    } else if (platform === 'fb') {
      runArgs.push('--draft');
    }
    
    try {
      await runCommand('npx', runArgs);
      console.log(`✓ Selesai memuat naik ke ${platform.toUpperCase()} untuk "${art.title}"`);
    } catch (err) {
      console.error(`❌ Gagal menjana/memuat naik untuk "${art.title}":`, err.message);
    }
  }

  console.log(`\n=== TUGASAN BATCH REELS ${platform.toUpperCase()} SELESAI ===`);
}

main().catch(err => {
  console.error("Ralat utama:", err);
  process.exit(1);
});
