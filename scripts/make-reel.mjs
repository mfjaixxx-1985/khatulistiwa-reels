// make-reel.mjs — Jana Reel/TikTok 9:16 (1080x1920) dari gambar + tajuk artikel dengan suara latar TTS.
// Teks dirender tajam guna sharp/SVG (kekal jelas), gambar diberi kesan Ken Burns
// (zoom perlahan) oleh ffmpeg. Muzik latar opsyenal.

import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const horizontal = process.argv.includes('--horizontal');
const W = horizontal ? 1920 : 1080;
const H = horizontal ? 1080 : 1920;

// ---------- baca argumen ----------
function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const imageArg = arg('image');
const title = arg('title');
const summary = arg('summary', '');
let music = arg('music');
if (music === 'none') music = null;
else if (!music) {
  for (const cand of ['public/audio/bg-music.mp3', 'public/audio/edu-ambient.mp3']) {
    try { await readFile(path.resolve(cand)); music = path.resolve(cand); break; } catch {}
  }
}
const out = arg('out', 'reel.mp4');
const dur = Number(arg('dur', '30'));
const closeup = !process.argv.includes('--wide');
const lang = arg('lang', 'ms');
const narrate = process.argv.includes('--narrate'); // Dimatikan secara lalai; guna --narrate untuk aktifkan

const L = {
  en: { badge: 'NEWS',     cta: 'READ FULL STORY →' },
  ms: { badge: 'BERITA',   cta: 'BACA PENUH DI LAMAN →' },
  id: { badge: 'BERITA',   cta: 'BACA SELENGKAPNYA →' },
  es: { badge: 'NOTICIAS', cta: 'LEER MÁS EN LA WEB →' },
  pt: { badge: 'NOTÍCIAS', cta: 'LEIA MAIS NO SITE →' },
  ar: { badge: 'أخبار',    cta: '← اقرأ المزيد' },
};
const T = L[lang] || L.ms;

if (!imageArg || !title) {
  console.error('Perlu --image dan --title.');
  process.exit(1);
}

// ---------- util ----------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function wrap(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = (line + ' ' + w).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function loadImageBuffer(src) {
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Gagal muat gambar: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return readFile(path.resolve(src));
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} keluar ${code}`))));
  });
}

// Fungsi pembantu untuk menjana suara latar menggunakan edge-tts-universal
async function generateTTS(text, voice, outputPath) {
  const { Communicate } = await import('edge-tts-universal');
  const { createWriteStream } = await import('node:fs');
  
  const communicate = new Communicate(text, { voice });
  const fileStream = createWriteStream(outputPath);
  for await (const chunk of communicate.stream()) {
    if (chunk.type === 'audio' && chunk.data) {
      fileStream.write(chunk.data);
    }
  }
  fileStream.end();
  await new Promise((resolve) => fileStream.on('finish', resolve));
}

// ---------- 1. pecahkan tldr atau summary kepada bullet points penting ----------
const tldr = arg('tldr');
const textToParse = tldr || summary || '';
let points = [];

if (textToParse.includes('\n-') || textToParse.startsWith('-') || textToParse.includes('\n*') || textToParse.startsWith('*')) {
  points = textToParse
    .split('\n')
    .map(p => p.replace(/^[-\*]\s*/, '').trim())
    .filter(p => p.length > 0);
} else {
  points = textToParse
    .split(/[.!?]+(?:\s+|$)/)
    .map(p => p.trim())
    .filter(p => p.length > 10);
}
points = points.slice(0, 3);

const numScenes = points.length + 2; // Hook + Points + Outro

const hookDur = 5;
const outroDur = 4;
const remainingDur = Math.max(5, dur - hookDur - outroDur);
const pointDur = remainingDur / Math.max(1, points.length);

const sceneTimes = [];
let startTime = 0;

sceneTimes.push({ start: 0, end: hookDur });
startTime += hookDur;

for (let i = 0; i < points.length; i++) {
  sceneTimes.push({ start: startTime, end: startTime + pointDur });
  startTime += pointDur;
}

sceneTimes.push({ start: startTime, end: dur });

const tmp = os.tmpdir();
const overlayFiles = [];

// ---------- 2. Bina Overlay SVG & Render ke PNG ----------

// A. Babak 0 (Hook / Title)
const titleLines = wrap(esc(title.toUpperCase()), horizontal ? 24 : 12);
const titleFont = horizontal ? (titleLines.length > 3 ? 64 : 76) : (titleLines.length > 3 ? 84 : 96);
const titleStartY = H / 2 - (titleLines.length * (titleFont + 18)) / 2 + 50;
const titleTspans = titleLines
  .map((l, i) => `<tspan x="${W / 2}" dy="${i === 0 ? 0 : titleFont + 18}">${l}</tspan>`)
  .join('');

const hookSvg = `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0.65"/>
      <stop offset="45%" stop-color="#000" stop-opacity="0.30"/>
      <stop offset="78%" stop-color="#000" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.97"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <g transform="translate(${W / 2}, ${H * 0.18})">
    <text text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="44" font-weight="900" letter-spacing="8">
      <tspan fill="#ffffff">KH</tspan><tspan fill="#00D2F9">AT</tspan><tspan fill="#ffffff">ULISTIWA</tspan>
    </text>
    <rect x="-100" y="24" width="200" height="4" fill="#00D2F9"/>
  </g>
  <g transform="translate(${W / 2}, ${titleStartY - 80})">
    <rect x="-120" y="-30" width="240" height="52" rx="10" fill="#00D2F9"/>
    <text x="0" y="6" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="28" font-weight="900" fill="#001018">${esc(T.badge)}</text>
  </g>
  <text text-anchor="middle" x="${W / 2}" y="${titleStartY}" font-family="DejaVu Sans, sans-serif" font-size="${titleFont}" font-weight="900" fill="#ffffff" stroke="#000000" stroke-width="16" paint-order="stroke fill" letter-spacing="1">
    ${titleTspans}
  </text>
</svg>`;

const hookPng = path.join(tmp, `reel-ov-hook-${process.pid}.png`);
console.log('• Menjana overlay Hook…');
await sharp(Buffer.from(hookSvg)).png().toFile(hookPng);
overlayFiles.push(hookPng);

// B. Babak 1 ke N-2 (Points)
for (let idx = 0; idx < points.length; idx++) {
  const point = points[idx];
  const pointLines = wrap(esc(point), horizontal ? 50 : 26);
  let pointFont = horizontal ? 54 : 64;
  let dyOffset = horizontal ? 14 : 18;
  if (pointLines.length > 5) {
    pointFont = horizontal ? 36 : 46;
    dyOffset = horizontal ? 10 : 12;
  } else if (pointLines.length > 4) {
    pointFont = horizontal ? 40 : 52;
    dyOffset = horizontal ? 12 : 14;
  } else if (pointLines.length > 3) {
    pointFont = horizontal ? 46 : 58;
    dyOffset = horizontal ? 12 : 16;
  }
  const pointStartY = H / 2 - (pointLines.length * (pointFont + dyOffset)) / 2 + 80;
  const pointTspans = pointLines
    .map((l, i) => `<tspan x="${W / 2}" dy="${i === 0 ? 0 : pointFont + dyOffset}">${l}</tspan>`)
    .join('');

  const pointSvg = `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0.65"/>
      <stop offset="45%" stop-color="#000" stop-opacity="0.30"/>
      <stop offset="78%" stop-color="#000" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.97"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <g transform="translate(${W / 2}, ${H * 0.18})">
    <text text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="44" font-weight="900" letter-spacing="8">
      <tspan fill="#ffffff">KH</tspan><tspan fill="#00D2F9">AT</tspan><tspan fill="#ffffff">ULISTIWA</tspan>
    </text>
    <rect x="-100" y="24" width="200" height="4" fill="#00D2F9"/>
  </g>
  <text text-anchor="middle" x="${W / 2}" y="${pointStartY - (horizontal ? 90 : 130)}" font-family="DejaVu Sans, sans-serif" font-size="${horizontal ? 120 : 160}" font-weight="900" fill="#00D2F9" opacity="0.9">0${idx + 1}</text>
  <text text-anchor="middle" x="${W / 2}" y="${pointStartY}" font-family="DejaVu Sans, sans-serif" font-size="${pointFont}" font-weight="800" fill="#ffffff" stroke="#000000" stroke-width="12" paint-order="stroke fill" letter-spacing="1">
    ${pointTspans}
  </text>
</svg>`;

  const pointPng = path.join(tmp, `reel-ov-point-${idx}-${process.pid}.png`);
  console.log(`• Menjana overlay Point ${idx + 1}…`);
  await sharp(Buffer.from(pointSvg)).png().toFile(pointPng);
  overlayFiles.push(pointPng);
}

// C. Babak N-1 (Outro / CTA)
const outroSvg = `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0.65"/>
      <stop offset="45%" stop-color="#000" stop-opacity="0.30"/>
      <stop offset="78%" stop-color="#000" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.97"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <g transform="translate(${W / 2}, ${H * 0.35})">
    <text text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="64" font-weight="900" letter-spacing="10">
      <tspan fill="#ffffff">KH</tspan><tspan fill="#00D2F9">AT</tspan><tspan fill="#ffffff">ULISTIWA</tspan>
    </text>
    <rect x="-150" y="32" width="300" height="5" fill="#00D2F9"/>
  </g>
  <g transform="translate(${W / 2}, ${H * 0.58})">
    <rect x="-300" y="-45" width="600" height="90" rx="45" fill="#00D2F9"/>
    <text x="0" y="12" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="34" font-weight="900" fill="#001018">${esc(T.cta)}</text>
  </g>
  <g transform="translate(${W / 2}, ${H * 0.85})">
    <text text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="32" font-weight="700" fill="#ffffff" letter-spacing="3" opacity="0.9">khatulistiwa.org</text>
  </g>
</svg>`;

const outroPng = path.join(tmp, `reel-ov-outro-${process.pid}.png`);
console.log('• Menjana overlay Outro…');
await sharp(Buffer.from(outroSvg)).png().toFile(outroPng);
overlayFiles.push(outroPng);

// ---------- 2b. Jana Suara Latar TTS (Microsoft Edge Neural) ----------
const ttsFiles = [];
if (narrate) {
  console.log('• Menjana suara latar TTS (Microsoft Yasmin)…');
  const VOICES = {
    ms: 'ms-MY-YasminNeural',
    id: 'id-ID-GadisNeural',
    en: 'en-US-EmmaMultilingualNeural',
  };
  const voice = VOICES[lang] || VOICES.ms;
  
  const outroTexts = {
    ms: 'Dapatkan berita penuh di laman web khatulistiwa dot o r g. Layari sekarang.',
    id: 'Dapatkan berita selengkapnya di situs khatulistiwa dot o r g. Kunjungi sekarang.',
    en: 'Read the full story on khatulistiwa dot o r g. Visit now.',
  };
  const outroText = outroTexts[lang] || outroTexts.ms;

  const ttsTexts = [
    `${title}.`,
    ...points,
    outroText
  ];

  for (let i = 0; i < numScenes; i++) {
    const ttsPath = path.join(tmp, `reel-tts-${i}-${process.pid}.mp3`);
    try {
      await generateTTS(ttsTexts[i], voice, ttsPath);
      ttsFiles.push(ttsPath);
      console.log(`  ✓ Suara latar babak ${i} dijana.`);
    } catch (err) {
      console.warn(`  ⚠️ Gagal menjana suara latar babak ${i}:`, err.message);
    }
  }
}

const bgPng = path.join(tmp, `reel-bg-${process.pid}.png`);

// ---------- 3. Sediakan Latar Belakang Gambar ----------
console.log(`• Menyediakan latar belakang gambar${closeup ? ' (close-up)' : ''}…`);
const BW = Math.round(W * 1.5), BH = Math.round(H * 1.5);
const imgBuf = await loadImageBuffer(imageArg);
let pipe = sharp(imgBuf).resize(BW, BH, { fit: 'cover', position: 'attention' });
if (closeup) {
  const cw = Math.round(BW * 0.68), ch = Math.round(BH * 0.68);
  const meta = await pipe.png().toBuffer();
  pipe = sharp(meta)
    .extract({ left: Math.round((BW - cw) / 2), top: Math.round((BH - ch) / 2), width: cw, height: ch })
    .resize(BW, BH, { fit: 'cover' });
}
await pipe.png().toFile(bgPng);

// ---------- 4. Gubah Video Menggunakan FFmpeg ----------
console.log('• Menggubah video dengan FFmpeg (Kesan khas multi-scene, fade & suara latar)…');
const fps = 30;
const frames = Math.round(dur * fps);
const zInc = (0.18 / frames).toFixed(6);

const vfParts = [];
// Latar belakang dengan pan/zoom perlahan
vfParts.push(`[0:v]scale=${BW}:${BH},zoompan=z='min(zoom+${zInc},1.18)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps}[bg]`);

// Bina penapis fade dan rantaian tindanan (overlay chain)
let lastOutput = '[bg]';
for (let i = 0; i < numScenes; i++) {
  const inputLabel = `[${i + 1}:v]`;
  const fadedLabel = `[faded${i}]`;
  const outputLabel = i === numScenes - 1 ? '[v]' : `[v${i}]`;
  const t = sceneTimes[i];
  
  const fadeDur = 1.0;
  vfParts.push(`${inputLabel}format=rgba,fade=in:st=${t.start.toFixed(2)}:d=${fadeDur.toFixed(2)}:alpha=1,fade=out:st=${(t.end - fadeDur).toFixed(2)}:d=${fadeDur.toFixed(2)}:alpha=1${fadedLabel}`);
  
  vfParts.push(`${lastOutput}${fadedLabel}overlay=0:0:enable='between(t,${t.start.toFixed(2)},${t.end.toFixed(2)})'${outputLabel}`);
  lastOutput = outputLabel;
}

// Audio mixing filters
let hasAudio = false;
const useTTS = narrate && ttsFiles.length === numScenes;

if (useTTS) {
  hasAudio = true;
  // Delay each TTS input
  for (let i = 0; i < numScenes; i++) {
    const ttsInputIndex = numScenes + 1 + i; // inputs: 0 (bg), 1..numScenes (overlays), numScenes+1..numScenes*2 (tts)
    const delayMs = Math.round(sceneTimes[i].start * 1000);
    vfParts.push(`[${ttsInputIndex}:a]adelay=${delayMs}|${delayMs}[a${i}]`);
  }
  // Mix delayed TTS inputs
  const delayedLabels = sceneTimes.map((_, i) => `[a${i}]`).join('');
  vfParts.push(`${delayedLabels}amix=inputs=${numScenes}:dropout_transition=99[narration]`);
  
  if (music) {
    const musicInputIndex = numScenes * 2 + 1;
    // Duck the background music volume to 10%
    vfParts.push(`[${musicInputIndex}:a]volume=0.10[bg_music]`);
    // Mix the narration with ducked music
    vfParts.push(`[narration][bg_music]amix=inputs=2:duration=first[a_mixed]`);
  } else {
    vfParts.push(`[narration]anull[a_mixed]`);
  }
} else if (music) {
  hasAudio = true;
  const musicInputIndex = numScenes + 1;
  vfParts.push(`[${musicInputIndex}:a]volume=0.60,afade=in:st=0:d=1,afade=out:st=${dur - 1.5}:d=1.5[a_mixed]`);
}

const vf = vfParts.join(';');

// Sediakan hujah-hujah (arguments) untuk arahan FFmpeg
const args = ['-y', '-loop', '1', '-t', String(dur), '-i', bgPng];
for (const file of overlayFiles) {
  args.push('-loop', '1', '-t', String(dur), '-i', file);
}
if (useTTS) {
  for (const file of ttsFiles) {
    args.push('-i', file);
  }
}
if (music) {
  const ss = Math.floor(Math.random() * 90);
  args.push('-ss', String(ss), '-stream_loop', '-1', '-i', path.resolve(music));
}

args.push('-filter_complex', vf, '-map', '[v]');
if (hasAudio) {
  args.push('-map', '[a_mixed]', '-c:a', 'aac', '-b:a', '128k');
}

args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(fps), '-t', String(dur),
  '-profile:v', 'high', '-preset', 'medium', '-movflags', '+faststart', path.resolve(out));

await run('ffmpeg', args);

// Padam semua fail sementara
await Promise.allSettled([bgPng, ...overlayFiles, ...ttsFiles].map(f => unlink(f)));
console.log(`\n✓ Siap: ${out}  (${W}x${H}, ${dur}s${music ? ', + muzik' : ', tiada muzik'}${useTTS ? ', + suara latar' : ''})`);
