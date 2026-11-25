// اختبارات محلل الوسوم tags.js + اختبار منطق الإصلاحات الجديدة (node)
import { parseAudioTags } from '../tags.js';

let pass = 0; let fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ---------- أدوات بناء ملفات اصطناعية ----------
const u8 = (arr) => new Uint8Array(arr);
const strBytes = (s, enc = 'utf-8') => u8(new TextEncoder().encode(s));
const concat = (parts) => new Blob(parts);

function id3v2(fileBytes, title, artist, album, picMime, picBytes) {
  // إطار نصي v2.3: حجمه u32 عادي، ونصه UTF-8 (enc=3 — الشكل المدعوم في id3Text)
  const frame = (fid, text) => {
    const body = concat([u8([0x03]), strBytes(text)]);
    const size = body.size;
    return concat([strBytes(fid), u8([(size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff]), u8([0, 0]), body]);
  };
  const frames = [frame('TIT2', title), frame('TPE1', artist), frame('TALB', album)];
  if (picBytes) {
    // APIC: enc(0) + mime + 0 + picType(0) + description + 0 + بيانات الصورة
    const pb = concat([u8([0x00]), strBytes(picMime, 'latin1'), u8([0x00]), u8([0x00]), strBytes('cover', 'latin1'), u8([0x00]), picBytes]);
    const sz = pb.size;
    frames.push(concat([strBytes('APIC'), u8([(sz >>> 24) & 0xff, (sz >>> 16) & 0xff, (sz >>> 8) & 0xff, sz & 0xff]), u8([0, 0]), pb]));
  }
  const body = concat(frames);
  const sz = body.size;
  // حجم التاج كله syncsafe دائمًا حسب المواصفة
  const tag = concat([strBytes('ID3'), u8([0x03, 0x00, 0x00]), u8([(sz >>> 21) & 0x7f, (sz >>> 14) & 0x7f, (sz >>> 7) & 0x7f, sz & 0x7f]), body]);
  return concat([tag, fileBytes]);
}

function mp4WithTags(title, artist, moovAtEnd = false) {
  const box = (nameBytes, ...children) => {
    const b = concat(children);
    const sz = b.size + 4 + nameBytes.length;
    return concat([u8([(sz >>> 24) & 0xff, (sz >>> 16) & 0xff, (sz >>> 8) & 0xff, sz & 0xff]), nameBytes, b]);
  };
  const NAME = { nam: u8([0xA9, 0x6e, 0x61, 0x6d]), ART: u8([0xA9, 0x41, 0x52, 0x54]) };
  // data box: version/flags(kind=1 نص) + locale(4) + النص — المحلل بيقرأ النص من cs+8
  // أسماء العناصر بايتات خام بترميز latin1: © = 0xA9 (ده الشكل الحقيقي في MP4)
  const item = (nameBytes, value) => box(nameBytes, box('data', u8([0, 0, 0, 1]), u8([0, 0, 0, 0]), strBytes(value)));
  const ilst = box('ilst', item(NAME.nam, title), item(NAME.ART, artist));
  const meta = box('meta', u8([0, 0, 0, 0]), ilst);
  const udta = box('udta', meta);
  const moov = box('moov', box('mvhd', u8(100)), udta);
  const mdat = box('mdat', u8(64));
  return moovAtEnd ? concat([mdat, moov]) : concat([moov, mdat]);
}

// ftyp atom سليم: حجم 16 = رأس + براند + minor
function ftypBlob(rest) { return concat([u8([0, 0, 0, 16]), strBytes('ftyp'), strBytes('isom', 'latin1'), u8([0, 0, 0, 0x02]), rest]); }

function flacWithTags(title, artist, album, picBytes) {
  // VORBIS_COMMENT (type 4) ثم PICTURE (type 6) بأعلام last
  const vorbis = (() => {
    const vendor = strBytes('test-vendor');
    const le = (n) => u8([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
    // تعليقات Vorbis كل أطوالها little-endian حسب المواصفة
    const comments = [`TITLE=${title}`, `ARTIST=${artist}`, `ALBUM=${album}`].map((c) => concat([le(strBytes(c).length), strBytes(c)]));
    return concat([le(vendor.length), vendor, le(comments.length), ...comments]);
  })();
  const pic = (() => {
    const mime = strBytes('image/jpeg', 'latin1');
    const desc = strBytes('x', 'latin1');
    const ml = u8([(mime.length >>> 24) & 0xff, (mime.length >>> 16) & 0xff, (mime.length >>> 8) & 0xff, mime.length & 0xff]);
    const dl = u8([(desc.length >>> 24) & 0xff, (desc.length >>> 16) & 0xff, (desc.length >>> 8) & 0xff, desc.length & 0xff]);
    return concat([u8(4), ml, mime, dl, desc, u8(16), picBytes]);
  })();
  const blk = (last, type, body) => {
    const sz = body.size;
    return concat([u8([(last ? 0x80 : 0) | type, (sz >>> 16) & 0xff, (sz >>> 8) & 0xff, sz & 0xff]), body]);
  };
  return concat([strBytes('fLaC', 'latin1'), blk(0, 4, vorbis), blk(1, 6, pic)]);
}

// ---------- اختبارات ID3 ----------
console.log('ID3v2:');
{
  const f = id3v2(u8(32), 'أغنية الاختبار', 'محمد عبد الوهاب', 'ألبوم 7', null, null);
  const m = await parseAudioTags(f);
  ok(!!m, 'ملف ID3 بيتقري');
  ok(m && m.title === 'أغنية الاختبار', `العنوان العربي (${m && m.title})`);
  ok(m && m.artist === 'محمد عبد الوهاب', 'الفنان');
  ok(m && m.album === 'ألبوم 7', 'الألبوم (مهم للبحث الجديد)');
}
{
  const pic = u8(Array.from({ length: 64 }, (_, i) => i));
  const f = id3v2(u8(16), 'T1', 'A1', '', 'image/jpeg', pic);
  const m = await parseAudioTags(f);
  ok(m && !!m.picture, 'غلاف APIC');
  ok(m && m.picture && m.picture.type === 'image/jpeg', `نوع الغلاف (${m && m.picture && m.picture.type})`);
}
{
  const f = id3v2(u8(8), 'x', 'y', '', null, null);
  const m = await parseAudioTags(f);
  ok(m && m.title === 'x', 'نص ASCII عادي');
}

// ---------- اختبارات MP4 ----------
console.log('MP4/M4A:');
{
  const f = ftypBlob(mp4WithTags('أغنية M4A', 'فنان M4A', false));
  const m = await parseAudioTags(f);
  ok(m && m.title === 'أغنية M4A', `moov في البداية (${m && m.title})`);
  ok(m && m.artist === 'فنان M4A', 'الفنان');
}
{
  const f = ftypBlob(mp4WithTags('آخر الملف', 'A', true));
  const m = await parseAudioTags(f);
  ok(m && m.title === 'آخر الملف', `moov في الآخر (${m && m.title})`);
}

// ---------- اختبارات FLAC ----------
console.log('FLAC:');
{
  const pic = u8(Array.from({ length: 48 }, (_, i) => i + 5));
  const f = flacWithTags('أغنية FLAC', 'فنان FLAC', 'ألبوم FLAC', pic);
  const m = await parseAudioTags(f);
  ok(m && m.title === 'أغنية FLAC', `العنوان (${m && m.title})`);
  ok(m && m.artist === 'فنان FLAC', 'الفنان');
  ok(m && m.album === 'ألبوم FLAC', 'الألبوم');
  ok(m && !!m.picture, 'غلاف PICTURE');
}

// ---------- رفض الصيغ غير المدعومة ----------
console.log('رفض:');
{
  const m = await parseAudioTags(concat([strBytes('OggS'), u8(32)]));
  ok(m === null, 'OGG يرجع null (تحليل اسم الملف في app.js)');
  const m2 = await parseAudioTags(new Blob([u8(10)]));
  ok(m2 === null, 'ملف فاضي/مجهول يرجع null');
}

// ---------- فحص منطق الإصلاحات على نص الكود (بدون DOM) ----------
console.log('منطق الإصلاحات في app.js:');
const appSrc = (await import('node:fs')).readFileSync(new URL('../app.js', import.meta.url).pathname, 'utf-8');
ok(appSrc.includes("'queue', 'idx']"), 'الطابور والمؤشر داخل SAVED');
ok(appSrc.includes('t.resume = S.pos'), 'حفظ موضع الاستئناف الدوري');
ok(appSrc.includes('wantResume') && appSrc.includes('loadedmetadata'), 'استئناف الموضع عند التشغيل');
ok(appSrc.includes("a === 'delplyes'") && appSrc.includes("'undopl'"), 'تأكيد حذف القوائم + تراجع');
ok(appSrc.includes("set('stop'"), 'معالج stop في Media Session');
ok(!appSrc.includes('dataset.seen') && appSrc.includes('a !== lrcIdx'), 'مزامنة الكلمات بفهرس تتبع');
ok(appSrc.includes('NotAllowedError'), 'رسالة التشغيل المحجوب');
ok(appSrc.includes('t.album || \'\')'), 'البحث يشمل الألبوم');
ok(appSrc.includes('get blocked()'), 'علامة onblocked مكشوفة');
ok(appSrc.includes('mozPreservesPitch'), 'preservesPitch مضبوط صراحة');
const swSrc = (await import('node:fs')).readFileSync(new URL('../sw.js', import.meta.url).pathname, 'utf-8');
ok(swSrc.includes("VERSION = 'v4'"), 'إصدار عامل الخدمة v4');
ok(swSrc.includes("putMeta('shareError'"), 'تسجيل فشل المشاركة');
const bootSrc = (await import('node:fs')).readFileSync(new URL('../boot.js', import.meta.url).pathname, 'utf-8');
ok(bootSrc.includes('shareError'), 'تنبيه فشل المشاركة عند الإقلاع');

console.log(`\nالنتيجة: ${pass} ناجح، ${fail} فاشل`);
process.exit(fail ? 1 : 0);
