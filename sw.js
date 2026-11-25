// Offline app shell. Bump VERSION when files change.
// التحديث ما بيسريش تلقائي: النسخة الجديدة بتستنى، والصفحة بتعرض زرار «حدّث».
const VERSION = 'v4';
const CACHE = `my-music-${VERSION}`;
const SHELL = ['./', './index.html', './boot.js', './app.js', './tags.js', './songs.js', './style.css', './fonts/kufi-Medium.woff2', './fonts/kufi-ExtraBold.woff2', './fonts/kufi-Medium.woff', './fonts/kufi-ExtraBold.woff', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];

self.addEventListener('install', (e) => {
  // تخزين فردي: فشل ملف واحد ما يفشلش التثبيت كله
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', (e) => {
  const r = e.request; const u = new URL(r.url);
  if (u.origin !== location.origin) return;
  // ملفات موشاركة من أندرويد: نخزنها في صندوق ونعيد التوجيه للواجهة
  if (r.method === 'POST' && (u.pathname.endsWith('/index.html') || u.pathname.endsWith('/'))) { e.respondWith(handleShare(r)); return; }
  if (r.method !== 'GET') return;
  e.respondWith(caches.match(r).then((hit) => hit || caches.match(u.pathname).then((hit2) => {
    if (hit2) return hit2;
    return fetch(r).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)); }
      return res;
    }).catch(() => caches.match('./index.html'));
  })));
});
async function openDb() {
  return new Promise((res, rej) => {
    const q = indexedDB.open('my-music', 1);
    q.onupgradeneeded = () => { q.result.createObjectStore('meta'); q.result.createObjectStore('blobs'); };
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
}
async function putMeta(key, val) {
  const db = await openDb();
  await new Promise((res, rej) => {
    const t = db.transaction('meta', 'readwrite');
    t.objectStore('meta').put(val, key);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}
async function handleShare(req) {
  // مشاركة ملفات من أندرويد: نجرب نحفظها في صندوق الوارد، ولو فشلنا نسجل سبب واضح بدل ما نبلع الخطأ بصمت
  let files = []; let why = '';
  try {
    const form = await req.formData();
    files = [...form.getAll('audio')].filter((x) => x && x.size);
  } catch { why = 'read'; }
  if (!why && files.length) {
    try { await putMeta('inbox', files); } catch { why = 'store'; }
  }
  if (why) {
    try { await putMeta('shareError', { why, at: Date.now() }); } catch { /* لو فشل تسجيل الخطأ نفسه مفيش حاجة نعملها هنا */ }
  }
  return Response.redirect('./index.html', 303);
}
