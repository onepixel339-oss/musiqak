// نقطة التشغيل: تركيب الواجهة + تسجيل عامل الخدمة + إشعار التحديث + استقبال الملفات من النظام
import { mount } from './app.js';

const app = mount(document.getElementById('app'));
const S = app.state;
await app.ready;

// ---------- عامل الخدمة + إشعار «فيه نسخة جديدة» ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const showUpd = () => {
      if (reg.waiting && !S.updReady && !S.toast) {
        S.updReady = reg.waiting;
        app.toast('فيه نسخة جديدة من التطبيق.', 'updnow', 'حدّث');
      }
    };
    showUpd();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (nw) nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpd(); });
    });
  }).catch(() => { /* التشغيل من file:// أو متصفح قديم */ });
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (S.updReady && !reloaded) { reloaded = true; location.reload(); }
  });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act=updnow]');
  if (b && S.updReady) { S.toast = null; S.updReady.postMessage('SKIP_WAITING'); }
});

// ---------- فتح التطبيق بملفات صوت من النظام (file_handlers) ----------
async function takeFiles(handles) {
  const files = [];
  for (const h of handles || []) {
    if (h && h.kind === 'file') { try { files.push(await h.getFile()); } catch { /* تجاهل */ } }
  }
  if (files.length) await app.addFiles(files);
}
if ('launchQueue' in window) {
  launchQueue.setConsumer(async (launchParams) => {
    await app.ready;
    if (launchParams.files && launchParams.files.length) await takeFiles(launchParams.files);
  });
}

// ---------- ملفات جاية من زرار «مشاركة» في أندرويد (share_target) ----------
(async () => {
  try {
    await app.ready; // نستنى تحميل المكتبة الأول عشان الـ dedup يشتغل صح
    // لو الملف المشارك من أندرويد فشل حفظه في عامل الخدمة: نجيب سببه ونحذره بدل ما يختفي بصمت
    const shareErr = await app.store.get('meta', 'shareError');
    if (shareErr) {
      await app.store.del('meta', 'shareError');
      app.toast('فيه ملف صوت اتبعت للتطبيق بالمشاركة بس مش قادرين نحفظه — المساحة ممكن تكون اتملت. فضّي مساحة وجرب تاني.', null, '', 0);
    }
    const inbox = await app.store.get('meta', 'inbox');
    if (inbox && inbox.length) {
      await app.store.del('meta', 'inbox');
      await app.addFiles(inbox);
    }
  } catch { /* ignore */ }
})();
