// مشغل موسيقاك: on-device music player. No network, no remote audio.
import { artists } from './songs.js';
import { parseAudioTags } from './tags.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ad = (n) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);
const fmt = (s) => { if (!isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60), r = Math.floor(s % 60); return ad(`${m}:${r < 10 ? '0' : ''}${r}`); };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const hue = (str) => { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

const PRESETS = {
  flat: ['عادي', [0, 0, 0, 0, 0]],
  bass: ['باص قوي', [7, 4, 0, -1, -1]],
  vocal: ['صوت المطرب', [-2, 0, 3, 4, 1]],
  treble: ['حدة عالية', [-1, -1, 0, 3, 6]],
  night: ['ليلي هادي', [3, 1, -1, -2, -3]],
};
const BANDS = [60, 230, 910, 3600, 14000];
const THEMES = { auto: ['أوتوماتيكي (لون الأغنية)', ''], teal: ['فيروزي', '#4fd1b5'], gold: ['دهبي', '#e6b450'], rose: ['وردي', '#f0708f'], violet: ['بنفسجي', '#9d8cff'] };

// ---------- storage: IndexedDB with in-memory fallback ----------
function makeStore() {
  const mem = { meta: new Map(), blobs: new Map() };
  let db = null; let persistent = false; let blocked = false;
  const ready = new Promise((res) => {
    try {
      const rq = indexedDB.open('my-music', 1);
      rq.onupgradeneeded = () => { rq.result.createObjectStore('meta'); rq.result.createObjectStore('blobs'); };
      rq.onsuccess = () => { db = rq.result; persistent = true; res(); };
      rq.onerror = () => res();
      // تبويب تاني ماسك قاعدة البيانات: نكمل بذاكرة مؤقتة ونحذر المستخدم بدل الصمت
      rq.onblocked = () => { blocked = true; res(); };
    } catch { res(); }
  });
  const tx = (store, mode, fn) => new Promise((res, rej) => {
    const t = db.transaction(store, mode); const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error);
  });
  return {
    ready,
    get persistent() { return persistent; },
    get blocked() { return blocked; },
    async get(store, k) { await ready; return db ? tx(store, 'readonly', (o) => o.get(k)) : mem[store].get(k); },
    async set(store, k, v) { await ready; if (db) return tx(store, 'readwrite', (o) => o.put(v, k)); mem[store].set(k, v); },
    async del(store, k) { await ready; if (db) return tx(store, 'readwrite', (o) => o.delete(k)); mem[store].delete(k); },
  };
}

export function mount(root) {
  const store = makeStore();
  const S = {
    tab: 'lib', filter: 'all', q: '', bq: '', bArtist: 'all', sheet: null, np: false,
    tracks: [], playlists: [], bookFavs: [], backup: [],
    queue: [], idx: -1, playing: false, shuffle: false, repeat: 'off',
    speed: 1, vol: 1, eq: 'flat', gains: [0, 0, 0, 0, 0], cf: 0, theme: 'auto',
    sleepAt: 0, sleepEnd: false, note: '', persistent: false, installEvt: null, pos: 0, dur: 0,
    toast: null, undoDel: null, undoPl: null, updReady: null, lrcFor: null,
  };
  const SAVED = ['playlists', 'bookFavs', 'shuffle', 'repeat', 'speed', 'vol', 'eq', 'gains', 'cf', 'theme', 'backup', 'queue', 'idx'];
  let saveT = 0;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { const o = { tracks: S.tracks }; SAVED.forEach((k) => { o[k] = S[k]; }); store.set('meta', 'state', o); }, 200); };

  const byId = (id) => S.tracks.find((t) => t.id === id);
  const cur = () => byId(S.queue[S.idx]);

  // ---------- رسائل مؤقتة (سطر حالة + تنبيه عائم قابل فيه لزر) ----------
  let noteT = 0; let toastT = 0;
  function note(text, sticky = false) {
    S.note = text; clearTimeout(noteT);
    if (!sticky) noteT = setTimeout(() => { if (S.note === text) { S.note = ''; render(); } }, 7000);
    render();
  }
  function toast(text, act = null, label = '', ttl = 0) {
    clearTimeout(toastT);
    S.toast = { text, act, label };
    if (ttl) toastT = setTimeout(() => { if (S.toast && S.toast.text === text) { S.toast = null; render(); } }, ttl);
    render();
  }

  // ---------- audio engine ----------
  const els = [new Audio(), new Audio()];
  els.forEach((e) => { e.preload = 'auto'; });
  let act = 0; let ctx = null; let gains = null; let filters = null; let master = null; let analyser = null; let vizOn = false; let prevNp = false; let prevSheet = false; let tabAnim = false; let skipEnter = false; let lastTid = null; let swapDir = 1; const urls = [null, null]; let crossing = false; let wired = false; let fadeT = 0; let accCache = ''; let sheetFocus = null; let lastRes = 0; let lrcIdx = -1;
  // السرعة مع الحفاظ على النغمة: نضبطها صراحة على كل عنصر صوت
  const applyRate = (e) => { e.playbackRate = S.speed; if ('preservesPitch' in e) e.preservesPitch = true; if ('webkitPreservesPitch' in e) e.webkitPreservesPitch = true; if ('mozPreservesPitch' in e) e.mozPreservesPitch = true; };
  const artCache = new Map();
  function wire() {
    if (wired) return; wired = true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext; ctx = new AC();
      gains = els.map((e) => { const s = ctx.createMediaElementSource(e); const g = ctx.createGain(); s.connect(g); return g; });
      filters = BANDS.map((f, i) => { const b = ctx.createBiquadFilter(); b.type = i === 0 ? 'lowshelf' : i === 4 ? 'highshelf' : 'peaking'; b.frequency.value = f; b.Q.value = 1; return b; });
      master = ctx.createGain();
      gains.forEach((g) => g.connect(filters[0]));
      filters.forEach((b, i) => { if (i) filters[i - 1].connect(b); });
      filters[4].connect(master); master.connect(ctx.destination);
      analyser = ctx.createAnalyser(); analyser.fftSize = 128; analyser.smoothingTimeConstant = 0.78; master.connect(analyser);
      applyEq();
    } catch { ctx = null; gains = null; filters = null; master = null; }
  }
  function applyEq() {
    if (filters) S.gains.forEach((g, i) => { filters[i].gain.value = g; });
    if (master) master.gain.value = S.vol; else els.forEach((e) => { e.volume = S.vol; });
  }
  const setGain = (i, v) => { if (gains) gains[i].gain.setValueAtTime(v, ctx.currentTime); else els[i].volume = v * S.vol; };
  const rampGain = (i, from, to, sec) => {
    if (gains) { const p = gains[i].gain; p.cancelScheduledValues(ctx.currentTime); p.setValueAtTime(from, ctx.currentTime); p.linearRampToValueAtTime(to, ctx.currentTime + sec); }
    else { const t0 = performance.now(); const tick = () => { const k = Math.min(1, (performance.now() - t0) / (sec * 1000)); els[i].volume = (from + (to - from) * k) * S.vol; if (k < 1) requestAnimationFrame(tick); }; tick(); }
  };

  async function loadInto(i, id) {
    const b = await store.get('blobs', id);
    if (!b) { note('الملف ده مش موجود. احذفه وضيفه تاني.'); return false; }
    if (urls[i]) URL.revokeObjectURL(urls[i]);
    urls[i] = URL.createObjectURL(b); els[i].src = urls[i]; applyRate(els[i]); return true;
  }
  async function playIndex(idx, { fade = false } = {}) {
    if (idx < 0 || idx >= S.queue.length) return;
    clearTimeout(fadeT);
    wire(); if (ctx && ctx.state === 'suspended') ctx.resume();
    const id = S.queue[idx]; const t = byId(id); if (!t) return;
    const prevEl = act; const nxt = fade ? 1 - act : act;
    if (!(await loadInto(nxt, id))) return;
    S.idx = idx; crossing = false; lastRes = 0; lrcIdx = -1;
    // استئناف ذكي: لو في موضع محفوظ للأغنية نكمل منه (ولو الملف خلص قبل كده نبدأ من الأول)
    const wantResume = t.resume || 0;
    if (wantResume > 2) {
      const seekTo = () => { try { const d = els[nxt].duration; els[nxt].currentTime = d && isFinite(d) ? Math.min(wantResume, Math.max(0, d - 1)) : wantResume; } catch { /* ignore */ } };
      if (els[nxt].readyState >= 1) seekTo(); else els[nxt].addEventListener('loadedmetadata', seekTo, { once: true });
    }
    if (fade) {
      setGain(nxt, 0); try { await els[nxt].play(); } catch (err) { if (err && err.name === 'NotAllowedError') note('المتصفح مانع التشغيل الآلي — دوس زرار التشغيل مرة واحدة وهيكمل عادي.'); }
      rampGain(nxt, 0, 1, S.cf); rampGain(prevEl, 1, 0, S.cf); crossing = true; act = nxt;
      fadeT = setTimeout(() => { els[prevEl].pause(); crossing = false; }, S.cf * 1000 + 100);
    } else {
      els.forEach((e, k) => { if (k !== nxt) e.pause(); }); act = nxt; setGain(nxt, 1);
      try { await els[nxt].play(); } catch (err) { if (err && err.name === 'NotAllowedError') note('المتصفح مانع التشغيل الآلي — دوس زرار التشغيل مرة واحدة وهيكمل عادي.'); }
    }
    t.plays = (t.plays || 0) + 1; t.lastPlayed = Date.now(); save(); media(); updateActive();
  }
  function shuffleRest() {
    const c = S.queue[S.idx]; const rest = S.queue.filter((x) => x !== c);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    S.queue = [c, ...rest]; S.idx = 0;
  }
  function startFrom(ids, id) { S.queue = ids.slice(); S.idx = Math.max(0, S.queue.indexOf(id)); if (S.shuffle) shuffleRest(); playIndex(S.idx); }
  function next(auto = false, fade = false) {
    if (!S.queue.length) return;
    let n = S.idx + 1;
    if (n >= S.queue.length) { if (S.repeat === 'all' || !auto) n = 0; else { S.playing = false; els[act].pause(); updateActive(); return; } }
    playIndex(n, { fade });
  }
  function prev() { if (els[act].currentTime > 3) { els[act].currentTime = 0; return; } playIndex(S.idx > 0 ? S.idx - 1 : S.queue.length - 1); }
  function toggle() {
    try { if (navigator.vibrate) navigator.vibrate(6); } catch { /* ignore */ }
    const e = els[act];
    if (!S.queue.length) { if (S.tracks.length) startFrom(S.tracks.map((t) => t.id), S.tracks[0].id); return; }
    // بعد إعادة فتح التطبيق: الطابور محفوظ لكن العنصر مش محمّل لسه — نشغّل المسار المحفوظ من موضع الاستئناف
    if (!e.currentSrc) { playIndex(S.idx); return; }
    wire(); if (ctx && ctx.state === 'suspended') ctx.resume();
    if (e.paused) e.play(); else e.pause();
  }

  els.forEach((e, i) => {
    e.addEventListener('play', () => { if (i === act) { S.playing = true; ms(); syncPlay(); } });
    e.addEventListener('pause', () => { if (i === act && !crossing) { S.playing = false; ms(); syncPlay(); } });
    e.addEventListener('error', () => {
      if (i !== act || crossing) return;
      const t = cur(); S.playing = false;
      note(`مش قادر أشغّل «${t ? t.title : 'الملف'}». الملف ممكن يكون تالف أو الصيغة مش مدعومة على المتصفح ده.`);
    });
    e.addEventListener('loadedmetadata', () => { if (i === act) { S.dur = e.duration; const t = cur(); if (t && !t.dur) { t.dur = e.duration; save(); } } });
    e.addEventListener('ended', () => {
      if (i !== act || crossing) return;
      const t = cur(); if (t) t.resume = 0; // خلصت طبيعيًا: الموضع المحفوظ يرجع للصفر
      if (S.sleepEnd) { S.sleepEnd = false; S.playing = false; updateActive(); return; }
      if (S.repeat === 'one') { e.currentTime = 0; e.play(); } else next(true);
    });
    e.addEventListener('timeupdate', () => {
      if (i !== act) return; S.pos = e.currentTime; S.dur = e.duration || S.dur; progress();
      // حفظ موضع الاستئناف كل 5 ثواني (وفورًا عند الرجوع للخلف) عشان استئناف الجلسة بعد الإغلاق
      if (S.pos - lastRes >= 5 || S.pos < lastRes) { lastRes = S.pos; const t = cur(); if (t) { t.resume = S.pos; save(); } }
      if (S.cf > 0 && !crossing && S.repeat !== 'one' && !S.sleepEnd && S.dur && S.dur - S.pos <= S.cf && S.dur > S.cf * 2 && (S.idx < S.queue.length - 1 || S.repeat === 'all')) next(true, true);
    });
  });
  setInterval(() => { if (S.sleepAt && Date.now() >= S.sleepAt) { S.sleepAt = 0; els.forEach((e) => e.pause()); updateActive(); } }, 1000);

  // ---------- media session ----------
  async function artUrl(t) {
    if (!t || !t.hasArt) return null;
    if (artCache.has(t.id)) return artCache.get(t.id);
    try {
      const b = await store.get('blobs', 'cover-' + t.id);
      if (!b) return null;
      const u = URL.createObjectURL(b); artCache.set(t.id, u); return u;
    } catch { return null; }
  }
  async function preloadArt() {
    const need = S.tracks.filter((t) => t.hasArt && !artCache.has(t.id));
    await Promise.all(need.map(async (t) => { await artUrl(t); }));
  }
  function artDataUrl(t) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d'); const h = hue(t.title + t.artist);
    const gr = g.createLinearGradient(0, 0, 256, 256); gr.addColorStop(0, `hsl(${h},60%,45%)`); gr.addColorStop(1, `hsl(${(h + 60) % 360},55%,22%)`);
    g.fillStyle = gr; g.fillRect(0, 0, 256, 256); g.fillStyle = 'rgba(255,255,255,.9)'; g.font = '110px sans-serif'; g.textAlign = 'center'; g.fillText('♪', 128, 170);
    return c.toDataURL('image/png');
  }
  async function media() {
    const m = navigator.mediaSession; const t = cur(); if (!m || !t) return;
    let art = null; try { art = await artUrl(t); } catch { art = null; }
    const artwork = [{ src: art || artDataUrl(t), sizes: art ? '512x512' : '256x256', type: art ? (t.artMime || 'image/jpeg') : 'image/png' }];
    try { m.metadata = new MediaMetadata({ title: t.title, artist: t.artist || 'مشغل موسيقاك', album: t.album || 'مكتبتي', artwork }); } catch { /* ignore */ }
  }
  function ms() { const m = navigator.mediaSession; if (m) m.playbackState = S.playing ? 'playing' : 'paused'; }
  const msn = navigator.mediaSession;
  if (msn) {
    const set = (a, f) => { try { msn.setActionHandler(a, f); } catch { /* unsupported */ } };
    set('play', toggle); set('pause', toggle); set('previoustrack', prev); set('nexttrack', () => next());
    set('seekto', (d) => { if (d.seekTime != null) els[act].currentTime = d.seekTime; });
    set('seekbackward', (d) => { els[act].currentTime = Math.max(0, els[act].currentTime - (d.seekOffset || 10)); });
    set('seekforward', (d) => { els[act].currentTime += d.seekOffset || 10; });
    set('stop', () => { els.forEach((x) => x.pause()); try { els[act].currentTime = 0; } catch { /* ignore */ } S.playing = false; ms(); syncPlay(); });
  }

  // ---------- library ops ----------
  const parseName = (fn) => { const base = fn.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim(); const p = base.split(' - '); return p.length > 1 ? { artist: p[0].trim(), title: p.slice(1).join(' - ').trim() } : { artist: '', title: base }; };
  const isAudio = (f) => (f.type && f.type.startsWith('audio/')) || /\.(mp3|m4a|aac|wav|ogg|opus|flac|weba)$/i.test(f.name);
  const probe = (blob) => new Promise((res) => {
    const a = new Audio(); const u = URL.createObjectURL(blob); let d0 = false;
    const done = (d) => { if (d0) return; d0 = true; URL.revokeObjectURL(u); res(d); };
    a.preload = 'metadata'; a.onloadedmetadata = () => done(a.duration); a.onerror = () => done(0); setTimeout(() => done(0), 4000); a.src = u;
  });
  async function pool(items, worker, size = 4) {
    const arr = items.slice(); let i = 0;
    const run = async () => { while (i < arr.length) { const k = i++; await worker(arr[k], k); } };
    await Promise.all(Array.from({ length: Math.min(size, arr.length) }, run));
  }
  async function addFiles(list) {
    const all = Array.from(list);
    const files = all.filter(isAudio);
    const skip = all.length - files.length;
    if (!files.length) { note(skip ? `تجاهلت ${ad(skip)} ملف مش صوت.` : 'مفيش ملفات صوت.'); return; }
    let done = 0; let added = 0; let quotaHit = false;
    await pool(files, async (f, seq) => {
      if (quotaHit) return;
      if (S.tracks.some((t) => t.file === f.name && t.size === f.size)) return;
      let meta = null; try { meta = await parseAudioTags(f); } catch { meta = null; }
      const pn = parseName(f.name);
      const id = uid();
      const t = { id, file: f.name, title: (meta && meta.title) || pn.title, artist: (meta && meta.artist) || pn.artist, album: (meta && meta.album) || '', size: f.size, added: Date.now(), batch: 1, seq, plays: 0, fav: false, lyrics: '', dur: 0 };
      const bk = (S.backup || []).find((b) => b.file === f.name && b.size === f.size);
      if (bk) { if (bk.title) t.title = bk.title; if (bk.artist) t.artist = bk.artist; if (bk.lyrics) t.lyrics = bk.lyrics; if (bk.fav) t.fav = true; if (bk.plays) t.plays = bk.plays; }
      try {
        if (meta && meta.picture) { try { await store.set('blobs', 'cover-' + id, meta.picture); t.hasArt = true; t.artMime = meta.picture.type; } catch { /* الغلاف اختياري */ } }
        await store.set('blobs', id, f);
      } catch (err) {
        quotaHit = true;
        toast(`المساحة اتملت قبل ما أحفظ «${t.title}». امسح أغاني أو ملفات تانية من المتصفح وجرب تاني.`, null, '', 0);
        return;
      }
      t.dur = await probe(f);
      S.tracks.push(t); added++; done++;
      note(`جاري الإضافة… ${ad(done)} / ${ad(files.length)}`);
      render();
    });
    S.tracks.sort((a, b) => (a.batch || 0) - (b.batch || 0) || (a.seq || 0) - (b.seq || 0));
    if (!quotaHit) note(`${added ? `ضفت ${ad(added)} أغنية.` : 'مفيش أغاني جديدة.'}${skip ? ` وتجاهلت ${ad(skip)} مش صوت.` : ''}`);
    await preloadArt(); save(); render();
  }
  async function removeTrack(id) {
    const t = byId(id); if (!t) return;
    const blob = await store.get('blobs', id);
    const coverBlob = t.hasArt ? await store.get('blobs', 'cover-' + id) : null;
    const qi = S.queue.indexOf(id);
    const wasCur = qi === S.idx;
    await store.del('blobs', id);
    if (t.hasArt) await store.del('blobs', 'cover-' + id);
    if (artCache.has(id)) { try { URL.revokeObjectURL(artCache.get(id)); } catch { /* ignore */ } artCache.delete(id); }
    S.tracks = S.tracks.filter((x) => x.id !== id);
    S.playlists.forEach((p) => { p.ids = p.ids.filter((x) => x !== id); });
    if (qi >= 0) {
      S.queue.splice(qi, 1);
      if (qi < S.idx) S.idx--;
      else if (wasCur) {
        els[act].pause();
        if (S.queue.length) playIndex(Math.min(S.idx, S.queue.length - 1));
        else { S.playing = false; S.idx = -1; }
      }
      if (S.idx >= S.queue.length) S.idx = S.queue.length - 1;
    }
    save(); render();
    if (blob) {
      const timer = setTimeout(() => { S.undoDel = null; render(); }, 9000);
      S.undoDel = { t, blob, coverBlob, timer };
      toast(`اتحذفت «${t.title}».`, 'undo', 'تراجع', 9000);
    }
  }
  async function undoDelete() {
    const u = S.undoDel; if (!u) return;
    clearTimeout(u.timer); S.undoDel = null; S.toast = null;
    try {
      await store.set('blobs', u.t.id, u.blob);
      if (u.coverBlob) await store.set('blobs', 'cover-' + u.t.id, u.coverBlob);
      S.tracks.push(u.t);
      S.tracks.sort((a, b) => (a.batch || 0) - (b.batch || 0) || (a.seq || 0) - (b.seq || 0));
      note(`رجعت «${u.t.title}» لمكانها.`);
    } catch { note('مش قادر أرجّعها — المساحة اتملت.'); }
    save(); render();
  }
  function listFor(f) {
    let l = S.tracks.slice();
    if (f === 'fav') l = l.filter((t) => t.fav);
    else if (f === 'recent') l = l.filter((t) => t.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed);
    else if (f === 'most') l = l.filter((t) => t.plays > 0).sort((a, b) => b.plays - a.plays);
    else if (f === 'new') l = l.sort((a, b) => b.added - a.added);
    else if (f !== 'all') { const p = S.playlists.find((x) => x.id === f); l = p ? p.ids.map(byId).filter(Boolean) : []; }
    else l.sort((a, b) => (a.artist + a.title).localeCompare(b.artist + b.title, 'ar'));
    const q = S.q.trim().toLowerCase();
    return q ? l.filter((t) => (t.title + ' ' + t.artist + ' ' + (t.album || '')).toLowerCase().includes(q)) : l;
  }

  // ---------- نسخة احتياطية + استيراد مجلد ----------
  async function exportBackup() {
    const o = {
      app: 'my-music', schemaVersion: 1, exportedAt: new Date().toISOString(),
      tracks: S.tracks.map((t) => ({ file: t.file, size: t.size, title: t.title, artist: t.artist, album: t.album || '', lyrics: t.lyrics || '', fav: !!t.fav, plays: t.plays || 0 })),
      playlists: S.playlists.map((p) => ({ name: p.name, ids: p.ids.map((x) => { const t = byId(x); return t ? t.file : null; }).filter(Boolean) })),
      bookFavs: S.bookFavs, settings: {},
    };
    SAVED.forEach((k) => { if (k !== 'playlists' && k !== 'bookFavs' && k !== 'backup' && k !== 'queue' && k !== 'idx') o.settings[k] = S[k]; });
    const blob = new Blob([JSON.stringify(o)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'my-music-backup.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    note('النسخة الاحتياطية نزلت في ملف التنزيلات. خليها في مكان آمن.');
  }
  async function importBackup(file) {
    if (!file) return;
    let o = null;
    try { o = JSON.parse(await file.text()); } catch { note('الملف ده مش ملف نسخة احتياطية صالح.'); return; }
    if (!o || o.app !== 'my-music' || !Array.isArray(o.tracks)) { note('الملف ده مش ملف نسخة احتياطية صالح.'); return; }
    S.backup = o.tracks.map((t) => ({ file: t.file, size: t.size, title: t.title || '', artist: t.artist || '', lyrics: t.lyrics || '', fav: !!t.fav, plays: t.plays || 0 }));
    if (Array.isArray(o.playlists)) {
      S.playlists = o.playlists.filter((p) => p && p.name).map((p) => ({ id: uid(), name: p.name, ids: (p.ids || []).map((f) => { const t = S.tracks.find((x) => x.file === f); return t ? t.id : null; }).filter(Boolean) }));
    }
    if (Array.isArray(o.bookFavs)) S.bookFavs = o.bookFavs;
    if (o.settings) Object.keys(o.settings).forEach((k) => { if (SAVED.includes(k)) S[k] = o.settings[k]; });
    let hit = 0;
    S.backup.forEach((b) => {
      const t = S.tracks.find((x) => x.file === b.file && x.size === b.size);
      if (t) { if (b.title) t.title = b.title; if (b.artist) t.artist = b.artist; if (b.lyrics) t.lyrics = b.lyrics; if (b.fav) t.fav = true; if (b.plays) t.plays = b.plays; hit++; }
    });
    const missing = S.backup.length - hit;
    note(`النسخة اترجعت: ${ad(hit)} أغنية اتطابقت.${missing ? ` و${ad(missing)} مش موجودة — أول ما تضيفها هتتربط تلقائيًا بالكلمات والمفضلة.` : ''}`);
    save(); render();
  }
  async function importFolder() {
    if (!('showDirectoryPicker' in window)) { note('المتصفح ده مش بيدعم استيراد المجلدات.'); return; }
    let dir;
    try { dir = await window.showDirectoryPicker(); } catch { return; }
    note('جاري قراءة المجلد…', true);
    const files = [];
    async function scan(d) {
      for await (const [, h] of d.entries()) {
        if (h.kind === 'directory') await scan(h);
        else if (h.kind === 'file' && isAudio(h)) { try { files.push(await h.getFile()); } catch { /* ملف مقفول */ } }
      }
    }
    try { await scan(dir); } catch { note('مش قادر أقرا المجلد ده.'); return; }
    if (!files.length) { note('ملفوش ملفات صوت في المجلد ده.'); return; }
    note(`لقيت ${ad(files.length)} ملف صوت…`);
    await addFiles(files);
  }

  // ---------- views ----------
  const cover = (t, cls = '') => {
    const u = artCache.get(t.id);
    const inner = u ? `<img class="pp-cimg" src="${u}" alt="" loading="lazy">` : `<span>${esc(cls === 'lg' ? ((t.title || '♪').trim().split(/\s+/)[0]) : (t.title || '♪').trim().charAt(0))}</span>`;
    return `<div class="pp-cover ${cls}" style="--h:${hue(t.title + t.artist)}">${inner}</div>`;
  };
  const IC = { play: '▶︎', pause: '❚❚', next: '⏭︎', prev: '⏮︎', shuf: '⤮', rep: '↻', heart: '♥', more: '⋯', down: '⌄', q: '☰', x: '✕' };
  const ic = (n) => IC[n] || n;

  function trackRow(t, list) {
    const on = cur() && cur().id === t.id;
    return `<div class="pp-row ${on ? 'on' : ''}">
      <button class="pp-rowmain" data-act="play" data-id="${t.id}" data-list="${esc(list)}">${cover(t, 'sm')}<span class="pp-rt"><b>${esc(t.title)}</b><small>${esc(t.artist || 'فنان غير معروف')} · ${fmt(t.dur)}</small></span>${on ? '<i class="pp-eqb"><u></u><u></u><u></u></i>' : ''}</button>
      <button class="pp-ib ${t.fav ? 'hot' : ''}" data-act="fav" data-id="${t.id}" aria-label="مفضلة" aria-pressed="${!!t.fav}">${ic('heart')}</button>
      <button class="pp-ib" data-act="more" data-id="${t.id}" aria-label="خيارات">${ic('more')}</button></div>`;
  }
  function libView() {
    const chips = [['all', 'الكل'], ['fav', '♥ المفضلة'], ['recent', 'اتسمعت مؤخرا'], ['most', 'الأكثر سماعا'], ['new', 'الأحدث']];
    return `<section>
      <label class="pp-add"><input type="file" id="pp-file" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac" multiple>＋ ضيف أغاني من موبايلك</label>
      ${S.note ? `<p class="pp-note" role="status" aria-live="polite">${esc(S.note)}</p>` : ''}
      ${S.persistent ? '' : '<p class="pp-warn">النسخة التجريبية دي مش بتحفظ أغانيك. بعد النشر كتطبيق الأغاني بتفضل محفوظة.</p>'}
      <input class="pp-search" id="pp-q" type="search" placeholder="ابحث في أغانيك" value="${esc(S.q)}" aria-label="بحث">
      <div class="pp-chips">${chips.map(([k, l]) => `<button class="pp-chip" data-act="filter" data-k="${k}" aria-pressed="${S.filter === k}">${l}</button>`).join('')}</div>
      <div class="pp-actions"><button class="pp-btn" data-act="playall">▶︎ شغّل الكل</button><button class="pp-btn" data-act="shufall">⤮ عشوائي</button><span class="pp-note">${ad(S.tracks.length)} أغنية</span></div>
      <div id="pp-list"></div></section>`;
  }
  function listHtml() {
    const l = listFor(S.filter);
    if (!S.tracks.length) return '<p class="pp-empty">لسه مفيش أغاني. دوس «ضيف أغاني» واختار ملفات mp3 أو m4a.</p>';
    if (!l.length) return '<p class="pp-empty">مفيش نتايج.</p>';
    return l.map((t) => trackRow(t, S.filter)).join('');
  }
  function plView() {
    const sel = S.playlists.find((p) => p.id === S.filter);
    return `<section><div class="pp-actions"><input class="pp-search" id="pp-pn" placeholder="اسم بلاي ليست جديدة" aria-label="اسم بلاي ليست"><button class="pp-btn" data-act="newpl">إنشاء</button></div>
      <div class="pp-chips">${S.playlists.map((p) => `<button class="pp-chip" data-act="filter" data-k="${p.id}" aria-pressed="${S.filter === p.id}">${esc(p.name)} (${ad(p.ids.length)})</button>`).join('') || '<p class="pp-empty">لسه مفيش بلاي ليست.</p>'}</div>
      ${sel ? `<div class="pp-actions"><button class="pp-btn" data-act="playall">▶︎ شغّل</button><button class="pp-btn" data-act="shufall">⤮ عشوائي</button><button class="pp-btn" data-act="delpl" data-id="${sel.id}">امسح البلاي ليست</button></div><div id="pp-list"></div>` : ''}</section>`;
  }
  const allBook = artists.flatMap((a) => a.songs.map((s) => ({ ...s, artist: a.name.replace('على نفس الطريقة: ', '') })));
  function bookView() {
    const names = artists.map((a) => a.name.replace('على نفس الطريقة: ', ''));
    const q = S.bq.trim();
    const l = allBook.filter((s) => (S.bArtist === 'all' || (S.bArtist === 'fav' ? S.bookFavs.includes(s.id) : s.artist === S.bArtist)) && (!q || s.name.includes(q) || s.artist.includes(q)));
    return `<section><p class="pp-note">${ad(allBook.length)} أغنية بلينكات يوتيوب الرسمية. بتفتح يوتيوب برة المشغل، ومفيش تحميل.</p>
      <input class="pp-search" id="pp-bq" type="search" placeholder="ابحث باسم أغنية أو فنان" value="${esc(S.bq)}" aria-label="بحث في الكتاب">
      <div class="pp-chips"><button class="pp-chip" data-act="bartist" data-k="all" aria-pressed="${S.bArtist === 'all'}">الكل</button><button class="pp-chip" data-act="bartist" data-k="fav" aria-pressed="${S.bArtist === 'fav'}">♥ المفضلة</button>${names.map((n) => `<button class="pp-chip" data-act="bartist" data-k="${esc(n)}" aria-pressed="${S.bArtist === n}">${esc(n)}</button>`).join('')}</div>
      <div id="pp-book">${l.map((s) => `<div class="pp-row"><div class="pp-rowmain"><span class="pp-rt"><b>${esc(s.name)}</b><small>${esc(s.artist)}${s.note ? ' · ' + esc(s.note) : ''}</small></span></div><button class="pp-ib ${S.bookFavs.includes(s.id) ? 'hot' : ''}" data-act="bfav" data-id="${s.id}" aria-label="مفضلة">${ic('heart')}</button><a class="pp-btn" href="https://www.youtube.com/watch?v=${s.id}" target="_blank" rel="noopener">يوتيوب</a></div>`).join('') || '<p class="pp-empty">مفيش نتايج.</p>'}</div></section>`;
  }
  function setView() {
    const used = S.tracks.reduce((a, t) => a + (t.size || 0), 0);
    return `<section>
      <h3>الشكل</h3><div class="pp-chips">${Object.entries(THEMES).map(([k, [l, c]]) => `<button class="pp-chip" data-act="theme" data-k="${k}" aria-pressed="${S.theme === k}">${c ? `<span class="pp-dot" style="background:${c}"></span>` : ''}${l}</button>`).join('')}</div>
      <p class="pp-note">«أوتوماتيكي» بيخلي لون التطبيق يتغير مع غلاف كل أغنية ويتحرك معاها بالتدريج، وغيره بتثبّت لون واحد.</p>
      <h3>الصوت</h3><div class="pp-actions"><button class="pp-btn" data-act="sheet" data-k="eq">إيكوليزر: ${PRESETS[S.eq] ? PRESETS[S.eq][0] : 'مخصص'}</button><button class="pp-btn" data-act="sheet" data-k="cf">دمج بين الأغاني: ${S.cf ? ad(S.cf) + ' ث' : 'مقفول'}</button></div>
      <h3>النسخة الاحتياطية</h3><div class="pp-actions"><button class="pp-btn" data-act="expbk">تصدير نسخة احتياطية</button><button class="pp-btn" data-act="impbk">استيراد نسخة احتياطية</button></div>
      <p class="pp-note">النسخة الاحتياطية بتحفظ القوائم والمفضلة والكلمات والإعدادات في ملف واحد. الأغاني نفسها بترجع تلقائي أول ما تضيف الملفات من تاني.</p>
      ${'showDirectoryPicker' in window ? `<div class="pp-actions"><button class="pp-btn" data-act="impdir">استورد مجلد أغاني كامل</button></div><p class="pp-note">بيلف على المجلد وكل اللي جواه (حتى المجلدات الفرعية) ويضيف كل ملفات الصوت.</p>` : ''}
      <h3>التخزين</h3><p class="pp-note">${ad(S.tracks.length)} أغنية، حوالي ${ad((used / 1048576).toFixed(0))} ميجا من ملفاتك. <span id="pp-quota"></span>${S.persistent ? 'محفوظة حتى لو قفلت التطبيق.' : 'مش محفوظة في النسخة دي.'}</p>
      ${S.installEvt ? '<button class="pp-btn pp-primary" data-act="install">ثبّت التطبيق على الموبايل</button>' : '<p class="pp-note">لو زرار التثبيت مش ظاهر: من قائمة كروم اختار «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».</p>'}
      <p class="pp-note">المشغل بيشتغل من غير نت. الأغاني ملكك وبتفضل على موبايلك بس.</p></section>`;
  }
  function miniHtml() {
    const t = cur(); if (!t) return '';
    return `<div class="pp-mini"><button class="pp-minimain" data-act="np">${cover(t, 'xs')}<span class="pp-rt"><b>${esc(t.title)}</b><small>${esc(t.artist || '')}</small></span></button><button class="pp-ib" data-act="prev" aria-label="السابق">${ic('prev')}</button><button class="pp-ib big" data-act="toggle" aria-label="تشغيل أو إيقاف">${S.playing ? ic('pause') : ic('play')}</button><button class="pp-ib" data-act="next" aria-label="التالي">${ic('next')}</button><div class="pp-mbar"><i id="pp-mfill"></i></div></div>`;
  }
  function lrc(t) { const out = []; (t.lyrics || '').split('\n').forEach((ln) => { const m2 = ln.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/); if (m2) out.push({ t: +m2[1] * 60 + +m2[2], x: m2[3].trim() }); }); return out; }
  function npHtml() {
    const t = cur(); if (!t) return '';
    const L = lrc(t); const plain = !L.length && t.lyrics;
    return `<div class="pp-np" role="dialog" aria-label="بيشتغل دلوقتي"><div class="pp-npbg" style="--h:${hue(t.title + t.artist)}"></div>
      <div class="pp-nptop"><button class="pp-ib" data-act="np" aria-label="اقفل">${ic('down')}</button><span>بيشتغل دلوقتي</span><button class="pp-ib" data-act="sheet" data-k="queue" aria-label="الطابور">${ic('q')}</button></div>
      ${cover(t, 'lg')}
      <div class="pp-nptitle"><b>${esc(t.title)}</b><small>${esc(t.artist || 'فنان غير معروف')}</small></div>
      <canvas id="pp-viz" class="pp-viz" width="560" height="64" aria-hidden="true"></canvas>
      <div class="pp-lyr" id="pp-lyr">${L.length ? L.map((l, i) => `<p data-i="${i}">${esc(l.x) || '♪'}</p>`).join('') : plain ? `<p class="plain">${esc(t.lyrics).replace(/\n/g, '<br>')}</p>` : '<p class="dim">مفيش كلمات. دوس «كلمات» وضيفها (ينفع بتوقيت LRC).</p>'}</div>
      <div class="pp-seek"><span id="pp-pos">${fmt(S.pos)}</span><input id="pp-seek" type="range" min="0" max="${Math.floor(S.dur || 0)}" step="1" value="${Math.floor(S.pos)}" aria-label="موضع التشغيل"><span>${fmt(S.dur)}</span></div>
      <div class="pp-ctl"><button class="pp-ib ${S.shuffle ? 'hot' : ''}" data-act="shuffle" aria-label="عشوائي" aria-pressed="${S.shuffle}">${ic('shuf')}</button><button class="pp-ib" data-act="prev" aria-label="السابق">${ic('prev')}</button><button class="pp-ib big2" data-act="toggle" aria-label="تشغيل أو إيقاف">${S.playing ? ic('pause') : ic('play')}</button><button class="pp-ib" data-act="next" aria-label="التالي">${ic('next')}</button><button class="pp-ib ${S.repeat !== 'off' ? 'hot' : ''}" data-act="repeat" aria-label="تكرار">${S.repeat === 'one' ? '↻١' : ic('rep')}</button></div>
      <div class="pp-tools"><button class="pp-chip" data-act="sheet" data-k="lyrics">كلمات</button><button class="pp-chip" data-act="sheet" data-k="eq">إيكوليزر</button><button class="pp-chip" data-act="sheet" data-k="speed">${ad(S.speed)}x سرعة</button><button class="pp-chip" data-act="sheet" data-k="sleep">${S.sleepAt ? 'نوم شغال' : S.sleepEnd ? 'نوم: آخر الأغنية' : 'مؤقت نوم'}</button><button class="pp-chip ${t.fav ? 'hot' : ''}" data-act="fav" data-id="${t.id}">♥</button></div></div>`;
  }
  function sheetHtml() {
    const k = S.sheet; if (!k) return '';
    let body = ''; let title = '';
    if (k === 'queue') {
      title = 'الطابور';
      body = '<div class="pp-actions"><button class="pp-btn" data-act="clearq">امسح الطابور</button></div>' + S.queue.map((id, i) => { const t = byId(id); if (!t) return ''; return `<div class="pp-row ${i === S.idx ? 'on' : ''}"><button class="pp-rowmain" data-act="qjump" data-i="${i}"><span class="pp-n">${ad(i + 1)}</span><span class="pp-rt"><b>${esc(t.title)}</b><small>${esc(t.artist || '')}</small></span></button><button class="pp-ib" data-act="qup" data-i="${i}" aria-label="فوق">↑</button><button class="pp-ib" data-act="qdn" data-i="${i}" aria-label="تحت">↓</button><button class="pp-ib" data-act="qrm" data-i="${i}" aria-label="شيل">${ic('x')}</button></div>`; }).join('');
    }
    if (k === 'eq') {
      title = 'إيكوليزر';
      body = `<div class="pp-chips">${Object.entries(PRESETS).map(([p, [l]]) => `<button class="pp-chip" data-act="preset" data-k="${p}" aria-pressed="${S.eq === p}">${l}</button>`).join('')}</div>` + BANDS.map((f, i) => `<label class="pp-eqrow"><span>${ad(f >= 1000 ? f / 1000 + 'k' : f)} هرتز</span><input type="range" min="-12" max="12" step="1" value="${S.gains[i]}" data-band="${i}" aria-label="نطاق ${f}"><output>${ad(S.gains[i])}</output></label>`).join('') + '<p class="pp-note">الإيكوليزر بيشتغل على الأغاني اللي بتتشغل من المشغل.</p>';
    }
    if (k === 'speed') { title = 'السرعة'; body = `<div class="pp-chips">${[0.75, 1, 1.25, 1.5, 2].map((s) => `<button class="pp-chip" data-act="speed" data-k="${s}" aria-pressed="${S.speed === s}">${ad(s)}x</button>`).join('')}</div>`; }
    if (k === 'cf') { title = 'دمج بين الأغاني'; body = `<div class="pp-chips">${[0, 2, 4, 6, 8, 12].map((s) => `<button class="pp-chip" data-act="cf" data-k="${s}" aria-pressed="${S.cf === s}">${s ? ad(s) + ' ثواني' : 'مقفول'}</button>`).join('')}</div><p class="pp-note">الأغنية اللي بعدها بتدخل بالتدريج على آخر اللي قبلها.</p>`; }
    if (k === 'sleep') { title = 'مؤقت النوم'; body = `<div class="pp-chips">${[15, 30, 45, 60].map((m2) => `<button class="pp-chip" data-act="sleep" data-k="${m2}">${ad(m2)} دقيقة</button>`).join('')}<button class="pp-chip" data-act="sleep" data-k="end">آخر الأغنية</button><button class="pp-chip" data-act="sleep" data-k="0">إلغاء</button></div>${S.sleepAt ? `<p class="pp-note">هيقف الساعة ${ad(new Date(S.sleepAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }))}</p>` : ''}`; }
    if (k === 'lyrics') { const t = cur(); title = 'كلمات الأغنية'; body = `<textarea id="pp-lyrta" rows="9" placeholder="الصق الكلمات هنا. لو كل سطر بتوقيت [00:12.50] هتتحرك مع الأغنية.">${esc(t ? t.lyrics : '')}</textarea><button class="pp-btn pp-primary" data-act="savelyr">حفظ</button>`; }
    if (k.addpl) { title = 'ضيف لبلاي ليست'; body = S.playlists.length ? S.playlists.map((p) => `<button class="pp-chip" data-act="addpl" data-id="${k.addpl}" data-k="${p.id}">${esc(p.name)}</button>`).join('') : '<p class="pp-empty">اعمل بلاي ليست الأول من تبويب «القوائم».</p>'; }
    if (k.more) { const t = byId(k.more); title = t ? t.title : ''; body = `<div class="pp-menu"><button class="pp-btn" data-act="playnext" data-id="${k.more}">شغّلها بعد دي</button><button class="pp-btn" data-act="addq" data-id="${k.more}">ضيفها للطابور</button><button class="pp-btn" data-act="sheet2" data-id="${k.more}">ضيفها لبلاي ليست</button><button class="pp-btn" data-act="lrcthis" data-id="${k.more}">استورد كلمات من ملف .lrc</button>${S.playlists.some((p) => p.id === S.filter) ? `<button class="pp-btn" data-act="rmpl" data-id="${k.more}">شيلها من البلاي ليست</button>` : ''}<button class="pp-btn" data-act="del" data-id="${k.more}">احذفها من المشغل</button></div>`; }
    if (k.confirm) { const t = byId(k.confirm); title = 'تأكيد الحذف'; body = `<p class="pp-note">هتحذف «${esc(t ? t.title : '')}» نهائيًا من المشغل (الملف الأصلي على الموبايل مش هيتأثر). متأكد؟</p><div class="pp-actions"><button class="pp-btn pp-primary" data-act="delyes" data-id="${k.confirm}">احذفها نهائيًا</button><button class="pp-btn" data-act="closesheet">تراجع</button></div>`; }
    if (k.delpl) { const p = S.playlists.find((x) => x.id === k.delpl); title = 'تأكيد حذف البلاي ليست'; body = `<p class="pp-note">هتمسح بلاي ليست «${esc(p ? p.name : '')}» (${ad(p ? p.ids.length : 0)} أغنية من القائمة — الأغاني نفسها هتفضل في المكتبة). متأكد؟</p><div class="pp-actions"><button class="pp-btn pp-primary" data-act="delplyes" data-id="${k.delpl}">امسح البلاي ليست</button><button class="pp-btn" data-act="closesheet">تراجع</button></div>`; }
    return `<div class="pp-scrim" data-act="closesheet"></div><div class="pp-sheet" role="dialog" aria-label="${esc(title)}"><div class="pp-sh"><b>${esc(title)}</b><button class="pp-ib" data-act="closesheet" aria-label="اقفل">${ic('x')}</button></div>${body}</div>`;
  }
  function syncPlay() {
    root.classList.toggle('is-playing', S.playing);
    root.querySelectorAll('[data-act=toggle]').forEach((b) => { b.textContent = S.playing ? ic('pause') : ic('play'); });
    root.querySelectorAll('.pp-ib.big,.pp-ib.big2').forEach((b) => { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); });
    startViz();
  }
  function startViz() {
    if (vizOn) return; const cv = $('#pp-viz', root); if (!cv || !S.playing) return; vizOn = true;
    const g = cv.getContext('2d'); const data = new Uint8Array(analyser ? analyser.frequencyBinCount : 32); const N = 28;
    const loop = () => {
      const c = $('#pp-viz', root);
      if (!c || !S.playing || !S.np) { vizOn = false; if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height); return; }
      const acc = accColor();
      g.clearRect(0, 0, c.width, c.height);
      if (analyser) analyser.getByteFrequencyData(data);
      const w = c.width / N;
      for (let i = 0; i < N; i++) {
        const v = analyser ? data[Math.floor((i / N) * data.length * 0.7)] / 255 : 0.15 + 0.1 * Math.sin(performance.now() / 200 + i);
        const h = Math.max(4, v * c.height * 0.95);
        g.fillStyle = acc; g.globalAlpha = 0.35 + v * 0.65;
        const x = i * w + w * 0.2; const bw = w * 0.6; const y = c.height - h;
        g.beginPath(); g.roundRect ? g.roundRect(x, y, bw, h, bw / 2) : g.rect(x, y, bw, h); g.fill();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  function vt(fn) {
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) { skipEnter = true; try { document.startViewTransition(fn); return; } catch { skipEnter = false; } }
    fn();
  }
  function bindSwipe() {
    const c = $('.pp-np .pp-cover.lg', root); if (!c) return;
    let x0 = null; let dx = 0;
    c.addEventListener('pointerdown', (e) => { x0 = e.clientX; dx = 0; c.setPointerCapture(e.pointerId); c.style.transition = 'none'; });
    c.addEventListener('pointermove', (e) => { if (x0 == null) return; dx = e.clientX - x0; c.style.transform = `translateX(${dx}px) rotate(${dx / 30}deg) scale(1)`; c.style.opacity = String(1 - Math.min(.5, Math.abs(dx) / 500)); });
    const end = () => {
      if (x0 == null) return; x0 = null; c.style.transition = 'transform .45s cubic-bezier(.34,1.56,.64,1), opacity .3s';
      if (Math.abs(dx) > 70 && S.queue.length > 1) { const go = dx < 0; c.style.transition = 'transform .22s ease-in, opacity .22s'; c.style.transform = `translateX(${dx < 0 ? -420 : 420}px) rotate(${dx < 0 ? -14 : 14}deg)`; c.style.opacity = '0'; swapDir = go ? 1 : -1; setTimeout(() => { if (go) next(); else prev(); }, 200); if (navigator.vibrate) navigator.vibrate(8); }
      else { c.style.transform = ''; c.style.opacity = ''; }
    };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  }
  function closeAnim(kind) {
    const el = kind === 'np' ? $('.pp-np', root) : $('.pp-sheet', root); const sc = $('.pp-scrim', root);
    if (!el) { if (kind === 'np') S.np = false; else S.sheet = null; render(); return; }
    el.classList.add('leave'); if (sc) sc.classList.add('leave');
    setTimeout(() => { if (kind === 'np') S.np = false; else S.sheet = null; render(); if (kind === 'sheet' && sheetFocus) { try { sheetFocus.focus(); } catch { /* ignore */ } sheetFocus = null; } }, 190);
  }
  // تحديث موضعي لحالة التشغيل بدل إعادة رسم الصفحة كلها (يبني القوائم الطويلة مرة واحدة)
  function updateActive() {
    const ct = cur();
    root.querySelectorAll('.pp-row.on').forEach((r) => r.classList.remove('on'));
    if (ct) root.querySelectorAll(`.pp-rowmain[data-id="${ct.id}"]`).forEach((r) => { const row = r.closest('.pp-row'); if (row) row.classList.add('on'); });
    let mini = $('.pp-mini', root);
    if (miniHtml() && !mini) { const nav = $('.pp-nav', root); if (nav) nav.insertAdjacentHTML('beforebegin', miniHtml()); mini = $('.pp-mini', root); }
    else if (!miniHtml() && mini) { mini.remove(); mini = null; }
    if (mini && ct) {
      const main = $('.pp-minimain', mini);
      if (main) main.innerHTML = `${cover(ct, 'xs')}<span class="pp-rt"><b>${esc(ct.title)}</b><small>${esc(ct.artist || '')}</small></span>`;
    }
    if (S.np && ct) {
      const np = $('.pp-np', root);
      const fresh = document.createElement('template'); fresh.innerHTML = npHtml().trim();
      const nf = fresh.content.firstElementChild;
      if (np && nf) { nf.classList.add('swap'); nf.style.setProperty('--dir', swapDir); np.replaceWith(nf); bindSwipe(); }
    }
    syncPlay(); progress(true);
  }
  const TABS = [['lib', 'المكتبة'], ['pl', 'القوائم'], ['book', 'الكتاب'], ['set', 'الإعدادات']];
  function render() {
    accCache = '';
    root.className = 'pp'; root.dir = 'rtl'; root.lang = 'ar'; root.dataset.theme = S.theme;
    const v = S.tab === 'lib' ? libView() : S.tab === 'pl' ? plView() : S.tab === 'book' ? bookView() : setView();
    const ct = cur(); const hh = ct ? hue(ct.title + ct.artist) : 285;
    root.style.setProperty('--c1', `hsl(${hh} 88% 58%)`); root.style.setProperty('--c2', `hsl(${(hh + 48) % 360} 82% 50%)`); root.style.setProperty('--c3', `hsl(${(hh + 300) % 360} 70% 30%)`);
    const toastHtml = S.toast ? `<div class="pp-toast" role="status" aria-live="polite"><span>${esc(S.toast.text)}</span>${S.toast.act ? `<button class="pp-btn" data-act="${S.toast.act}">${esc(S.toast.label || 'تمام')}</button>` : ''}<button class="pp-ib" data-act="toastx" aria-label="اقفل التنبيه">${ic('x')}</button></div>` : '';
    root.innerHTML = `<div class="pp-aur" aria-hidden="true"></div><header class="pp-head"><h1>مشغل موسيقاك</h1></header><main class="pp-main">${v}</main>${miniHtml()}<nav class="pp-nav">${TABS.map(([k, l]) => `<button data-act="tab" data-k="${k}" aria-current="${S.tab === k ? 'page' : 'false'}">${l}</button>`).join('')}</nav>${S.np ? npHtml() : ''}${sheetHtml()}${toastHtml}<input type="file" id="pp-bkfile" accept=".json,application/json" hidden><input type="file" id="pp-lrcfile" accept=".lrc,text/plain" hidden>`;
    const lst = $('#pp-list', root); if (lst) lst.innerHTML = listHtml();
    root.classList.toggle('is-playing', S.playing);
    root.classList.toggle('np-open', !!S.np);
    if (S.np && !prevNp && !skipEnter) { const n = $('.pp-np', root); if (n) n.classList.add('enter'); }
    skipEnter = false;
    if (S.np && ct && lastTid && lastTid !== ct.id) { const n = $('.pp-np', root); if (n) { n.classList.add('swap'); n.style.setProperty('--dir', swapDir); } }
    lastTid = ct ? ct.id : null; swapDir = 1; bindSwipe();
    if (S.sheet && !prevSheet) {
      root.querySelectorAll('.pp-sheet,.pp-scrim').forEach((n) => n.classList.add('enter'));
      const sf = $('.pp-sheet', root);
      if (sf) { sheetFocus = document.activeElement; const fb = sf.querySelector('button, input, textarea, [href]'); if (fb) { try { fb.focus(); } catch { /* ignore */ } } }
    }
    if (tabAnim) { const mn = $('.pp-main', root); if (mn) mn.classList.add('tabin'); tabAnim = false; }
    prevNp = S.np; prevSheet = !!S.sheet;
    progress(true); startViz();
    if (S.tab === 'set') fillQuota();
  }
  function progress(force) {
    const f = $('#pp-mfill', root); if (f && S.dur) f.style.width = `${Math.min(100, (S.pos / S.dur) * 100)}%`;
    const sk = $('#pp-seek', root);
    if (sk) { if (force || document.activeElement !== sk) { sk.max = Math.floor(S.dur || 0); sk.value = Math.floor(S.pos); }
      sk.style.setProperty('--p', (S.dur ? Math.min(100, (S.pos / S.dur) * 100) : 0) + '%'); const p = $('#pp-pos', root); if (p) p.textContent = fmt(S.pos); }
    const t = cur(); const ly = $('#pp-lyr', root);
    if (t && ly && ly.querySelector('[data-i]')) {
      const L = lrc(t); let a = -1; L.forEach((l, i) => { if (S.pos >= l.t) a = i; });
      // تتبع السطر النشط بفهرس واحد: التمرير يشتغل مع كل تغيّر (رجوع/تقديم/تكرار) مش مرة واحدة بس
      if (a !== lrcIdx) {
        lrcIdx = a;
        const ps = ly.querySelectorAll('p');
        ps.forEach((p, i) => p.classList.toggle('now', i === a));
        const n = a >= 0 && a < ps.length ? ps[a] : null;
        if (n) ly.scrollTo({ top: n.offsetTop - ly.clientHeight / 2, behavior: 'smooth' });
      }
    }
    if (navigator.mediaSession && navigator.mediaSession.setPositionState && S.dur && isFinite(S.dur)) { try { navigator.mediaSession.setPositionState({ duration: S.dur, position: Math.min(S.pos, S.dur), playbackRate: S.speed }); } catch { /* ignore */ } }
  }
  // لون السمة بيتجمع مرة واحدة بدل كل إطار
  const accColor = () => { if (!accCache) accCache = getComputedStyle(root).getPropertyValue('--acc').trim() || '#4fd1b5'; return accCache; };
  async function fillQuota() {
    const el = $('#pp-quota', root);
    if (!el || !navigator.storage || !navigator.storage.estimate) return;
    try {
      const { usage, quota } = await navigator.storage.estimate();
      if (el.isConnected) el.textContent = `الحصة الفعلية من المتصفح: مستخدم ${ad(((usage || 0) / 1048576).toFixed(0))} ميجا من نحو ${ad(((quota || 0) / 1073741824).toFixed(1))} جيجا.`;
    } catch { /* ignore */ }
  }

  // ---------- events ----------
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act; const id = b.dataset.id; const k = b.dataset.k;
    if (a === 'tab') { tabAnim = S.tab !== k; S.tab = k; S.filter = k === 'pl' ? (S.playlists[0] ? S.playlists[0].id : 'x') : 'all'; S.q = ''; render(); }
    else if (a === 'filter') { S.filter = k; render(); }
    else if (a === 'play') { const l = listFor(b.dataset.list || 'all').map((t) => t.id); startFrom(l.length ? l : [id], id); }
    else if (a === 'playall' || a === 'shufall') { const l = listFor(S.filter).map((t) => t.id); if (l.length) { S.shuffle = a === 'shufall'; const s = S.shuffle ? l[Math.floor(Math.random() * l.length)] : l[0]; startFrom(l, s); } }
    else if (a === 'fav') { const t = byId(id); if (t) { t.fav = !t.fav; save(); render(); } }
    else if (a === 'more') { S.sheet = { more: id }; render(); }
    else if (a === 'sheet') { S.sheet = k; render(); }
    else if (a === 'sheet2') { S.sheet = { addpl: id }; render(); }
    else if (a === 'closesheet') closeAnim('sheet');
    else if (a === 'np') { if (S.np) vt(() => { S.np = false; render(); }); else vt(() => { S.np = true; render(); }); }
    else if (a === 'toggle') toggle();
    else if (a === 'next') { swapDir = 1; next(); }
    else if (a === 'prev') { swapDir = -1; prev(); }
    else if (a === 'shuffle') { S.shuffle = !S.shuffle; if (S.shuffle && S.queue.length) shuffleRest(); save(); render(); }
    else if (a === 'repeat') { S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off'; save(); render(); }
    else if (a === 'speed') { S.speed = +k; els.forEach((x) => applyRate(x)); save(); render(); }
    else if (a === 'cf') { S.cf = +k; save(); render(); }
    else if (a === 'preset') { S.eq = k; S.gains = PRESETS[k][1].slice(); wire(); applyEq(); save(); render(); }
    else if (a === 'sleep') { S.sleepAt = 0; S.sleepEnd = false; if (k === 'end') S.sleepEnd = true; else if (+k) S.sleepAt = Date.now() + +k * 60000; S.sheet = null; render(); }
    else if (a === 'theme') { S.theme = k; save(); render(); }
    else if (a === 'newpl') { const i = $('#pp-pn', root); const n = i && i.value.trim(); if (n) { const p = { id: uid(), name: n, ids: [] }; S.playlists.push(p); S.filter = p.id; save(); render(); } }
    else if (a === 'delpl') { S.sheet = { delpl: id }; render(); }
    else if (a === 'delplyes') {
      const pid = S.sheet && S.sheet.delpl; S.sheet = null;
      const p = S.playlists.find((x) => x.id === pid);
      if (p) {
        S.playlists = S.playlists.filter((x) => x.id !== pid);
        S.filter = S.playlists[0] ? S.playlists[0].id : 'x';
        clearTimeout(S.undoPl && S.undoPl.timer);
        S.undoPl = { p, timer: setTimeout(() => { S.undoPl = null; render(); }, 9000) };
        save(); render();
        toast(`اتمسحت بلاي ليست «${p.name}».`, 'undopl', 'تراجع', 9000);
      } else render();
    }
    else if (a === 'undopl') {
      const u = S.undoPl; if (!u) return;
      clearTimeout(u.timer); S.undoPl = null; S.toast = null;
      u.p.ids = u.p.ids.filter((x) => byId(x));
      S.playlists.push(u.p); S.filter = u.p.id;
      save(); note(`رجعت بلاي ليست «${u.p.name}» بمكانها.`);
    }
    else if (a === 'addpl') { const p = S.playlists.find((x) => x.id === k); if (p && !p.ids.includes(id)) p.ids.push(id); S.sheet = null; save(); render(); }
    else if (a === 'rmpl') { const p = S.playlists.find((x) => x.id === S.filter); if (p) p.ids = p.ids.filter((x) => x !== id); S.sheet = null; save(); render(); }
    else if (a === 'del') { S.sheet = { confirm: id }; render(); }
    else if (a === 'delyes') { const cid = S.sheet && S.sheet.confirm; S.sheet = null; if (cid) await removeTrack(cid); }
    else if (a === 'undo') undoDelete();
    else if (a === 'toastx') { clearTimeout(toastT); S.toast = null; render(); }
    else if (a === 'expbk') exportBackup();
    else if (a === 'impbk') { const inp = $('#pp-bkfile', root); if (inp) inp.click(); }
    else if (a === 'impdir') importFolder();
    else if (a === 'lrcthis') { S.lrcFor = id; S.sheet = null; render(); const inp = $('#pp-lrcfile', root); if (inp) inp.click(); }
    else if (a === 'addq') { if (!S.queue.length) startFrom([id], id); else S.queue.push(id); S.sheet = null; render(); }
    else if (a === 'playnext') { if (!S.queue.length) startFrom([id], id); else S.queue.splice(S.idx + 1, 0, id); S.sheet = null; render(); }
    else if (a === 'qjump') playIndex(+b.dataset.i);
    else if (a === 'qrm') {
      const i = +b.dataset.i; const wasCur = i === S.idx;
      S.queue.splice(i, 1);
      if (i < S.idx) { S.idx--; render(); }
      else if (wasCur) {
        els[act].pause();
        if (S.queue.length) { await playIndex(Math.min(S.idx, S.queue.length - 1)); render(); }
        else { S.playing = false; S.idx = -1; render(); }
      }
      else { if (S.idx >= S.queue.length) S.idx = S.queue.length - 1; render(); }
    }
    else if (a === 'qup' || a === 'qdn') { const i = +b.dataset.i; const j = a === 'qup' ? i - 1 : i + 1; if (j >= 0 && j < S.queue.length) { [S.queue[i], S.queue[j]] = [S.queue[j], S.queue[i]]; if (S.idx === i) S.idx = j; else if (S.idx === j) S.idx = i; render(); } }
    else if (a === 'clearq') { const c = S.queue[S.idx]; S.queue = c ? [c] : []; S.idx = c ? 0 : -1; render(); }
    else if (a === 'savelyr') { const t = cur(); const ta = $('#pp-lyrta', root); if (t && ta) { t.lyrics = ta.value; save(); } S.sheet = null; render(); }
    else if (a === 'bartist') { S.bArtist = k; render(); }
    else if (a === 'bfav') { S.bookFavs = S.bookFavs.includes(id) ? S.bookFavs.filter((x) => x !== id) : [...S.bookFavs, id]; save(); render(); }
    else if (a === 'install') { S.installEvt.prompt(); S.installEvt = null; render(); }
  });
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'pp-q') { S.q = t.value; const l = $('#pp-list', root); if (l) l.innerHTML = listHtml(); }
    else if (t.id === 'pp-bq') { S.bq = t.value; const pos = t.selectionStart; render(); const n = $('#pp-bq', root); n.focus(); n.setSelectionRange(pos, pos); }
    else if (t.id === 'pp-seek') { els[act].currentTime = +t.value; t.style.setProperty('--p', (S.dur ? (+t.value / S.dur) * 100 : 0) + '%'); }
    else if (t.dataset.band != null) { S.gains[+t.dataset.band] = +t.value; S.eq = 'custom'; wire(); applyEq(); t.nextElementSibling.textContent = ad(t.value); save(); }
  });
  root.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'pp-file') { addFiles(t.files); t.value = ''; }
    else if (t.id === 'pp-bkfile') { const f = t.files && t.files[0]; t.value = ''; await importBackup(f); }
    else if (t.id === 'pp-lrcfile') {
      const f = t.files && t.files[0]; const tid = S.lrcFor; S.lrcFor = null; t.value = '';
      const tr = tid && byId(tid);
      if (f && tr) { try { tr.lyrics = await f.text(); save(); note(`كلمات «${tr.title}» اتحفظت من الملف.`); } catch { note('مش قادر أقرا ملف الكلمات.'); } }
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.target.id === 'pp-pn' && e.key === 'Enter') root.querySelector('[data-act=newpl]').click();
    if (e.key !== 'Tab' || !S.sheet) return;
    const sf = $('.pp-sheet', root); if (!sf) return;
    const foc = [...sf.querySelectorAll('button, input, textarea, [href]')].filter((x) => !x.disabled);
    if (!foc.length) return;
    const first = foc[0]; const last = foc[foc.length - 1];
    if (!sf.contains(document.activeElement)) { first.focus(); e.preventDefault(); }
    else if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  });
  // اختصارات سطح المكتب + Escape للنوافذ
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (S.sheet) { closeAnim('sheet'); e.preventDefault(); }
      else if (S.np) { vt(() => { S.np = false; render(); }); e.preventDefault(); }
      return;
    }
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowLeft') els[act].currentTime = Math.max(0, els[act].currentTime - 10);
    else if (e.key === 'ArrowRight') els[act].currentTime += 10;
    else if (e.key.toLowerCase() === 'n') next();
    else if (e.key.toLowerCase() === 'p') prev();
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; if (S.tab === 'set') render(); });

  // ---------- boot ----------
  const bootP = store.ready.then(async () => {
    S.persistent = store.persistent;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch { /* ignore */ }
    const saved = await store.get('meta', 'state');
    if (saved) { Object.assign(S, saved); if (!Array.isArray(S.tracks)) S.tracks = []; if (!Array.isArray(S.backup)) S.backup = []; }
    // تنظيف الطابور المستعاد: شيل معرفات أغاني اتحذفت، وثبّت المؤشر
    S.queue = Array.isArray(S.queue) ? S.queue.filter((id) => S.tracks.some((t) => t.id === id)) : [];
    if (!Array.isArray(S.playlists)) S.playlists = [];
    S.idx = Math.min(Math.max(S.idx || -1, -1), S.queue.length - 1);
    if (S.queue.length && S.idx === -1) S.idx = 0;
    if (S.queue.length && !cur()) S.idx = -1;
    // الواجهة تعرض موضع الاستئناف من أول لحظة (التشغيل نفسه بيتم بزرار المستخدم)
    const t0 = cur(); if (t0) { S.pos = t0.resume || 0; S.dur = t0.dur || 0; }
    if (store.blocked) toast('قاعدة البيانات محجوزة لتبويب تاني مفتوح لنفس الموقع — الحفظ هنا مش هيشتغل لحد ما تقفل التبويب التاني وتحدّث الصفحة.', null, '', 0);
    S.filter = 'all';
    await preloadArt();
    render();
  }).catch(() => {});
  render();
  return { state: S, addFiles, store, note, toast, ready: bootP };
}
