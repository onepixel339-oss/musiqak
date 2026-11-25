// قراءة وسوم الملفات الصوتية مباشرة من البايتات: ID3v2 (mp3) + MP4/M4A + FLAC، والأغلفة المدمجة.
// بلا أي تبعيات خارجية — كل القراءة من slice المحلي بدون تحميل الملف كله.
const decStr = (b, enc) => {
  let s = '';
  try { s = new TextDecoder(enc).decode(b); } catch { s = ''; }
  return s.replace(/[\u0000\uFEFF]/g, '').trim();
};
// latin1 لو فيه بايتات عربية غالبًا دي CP-1256 اللي كتبها المشغل القديم
const decLatin = (b) => {
  const s = decStr(b, 'latin1');
  return /[\u00c0-\u00ff]/.test(s) ? decStr(b, 'windows-1256') : s;
};
const ss32 = (b, o) => (((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f)) >>> 0;
const u32 = (b, o) => (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
const u24 = (b, o) => ((b[o] << 16) | (b[o + 1] << 8) | b[o + 2]) >>> 0;
const sig = (b, o, s) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) === s;

// ---------- ID3v2 (mp3) ----------
function id3Text(buf, s, e) {
  if (s >= e) return '';
  const enc = buf[s];
  const b = buf.subarray(s + 1, e);
  if (enc === 3) return decStr(b, 'utf-8');
  if (enc === 2) return decStr(b, 'utf-16be');
  if (enc === 1) {
    const be = b[0] === 0xfe && b[1] === 0xff;
    const off = b[0] === 0xff || b[0] === 0xfe ? 2 : 0;
    return decStr(b.subarray(off), be ? 'utf-16be' : 'utf-16le');
  }
  return decLatin(b);
}
function picFrame(buf, s, e, v22) {
  if (s >= e) return null;
  let o = s;
  const enc = buf[o++];
  let mime;
  if (v22) {
    mime = { 0: 'image/jpeg', 1: 'image/gif', 2: 'image/png', 3: 'image/bmp' }[buf[o]] || 'image/jpeg';
    o += 3;
  } else {
    let z = o;
    while (z < e && buf[z]) z++;
    mime = decStr(buf.subarray(o, z), 'latin1') || 'image/jpeg';
    o = z + 1;
  }
  o++; // picture type
  if (enc === 1 || enc === 2) { while (o + 1 < e && (buf[o] || buf[o + 1])) o += 2; o += 2; }
  else { while (o < e && buf[o]) o++; o++; }
  if (o >= e || e - o < 8) return null;
  const type = /png/i.test(mime) ? 'image/png' : /jpe?g/i.test(mime) ? 'image/jpeg' : mime.startsWith('image/') ? mime : 'image/jpeg';
  return new Blob([buf.subarray(o, e)], { type });
}
async function parseID3(file) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null;
  const ver = head[3];
  const size = ss32(head, 6);
  const buf = new Uint8Array(await file.slice(0, Math.min(size + 10, 8 * 1024 * 1024)).arrayBuffer());
  const out = {};
  const v22 = ver === 2;
  let o = 10;
  while (o + (v22 ? 6 : 10) <= Math.min(size + 10, buf.length)) {
    let fid, fsz, hsz;
    if (v22) {
      fid = String.fromCharCode(buf[o], buf[o + 1], buf[o + 2]);
      fsz = u24(buf, o + 3); hsz = 6;
      if (!/^[A-Z0-9]{3}$/.test(fid) || !fsz) break;
    } else {
      fid = String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
      fsz = ver === 4 ? ss32(buf, o + 4) : u32(buf, o + 4); hsz = 10;
      if (!/^[A-Z0-9]{4}$/.test(fid) || fsz <= 0 || o + hsz + fsz > size + 10) break;
    }
    const start = o + hsz; const end = Math.min(start + fsz, buf.length);
    if ((fid === 'TIT2' || fid === 'TT2') && !out.title) out.title = id3Text(buf, start, end);
    else if ((fid === 'TPE1' || fid === 'TP1') && !out.artist) out.artist = id3Text(buf, start, end);
    else if ((fid === 'TALB' || fid === 'TAL') && !out.album) out.album = id3Text(buf, start, end);
    else if ((fid === 'TDRC' || fid === 'TYER') && !out.year) out.year = id3Text(buf, start, end);
    else if ((fid === 'APIC' || fid === 'PIC') && !out.picture) { try { out.picture = picFrame(buf, start, end, fid === 'PIC'); } catch { out.picture = null; } }
    o = end;
  }
  return out.picture || out.title || out.artist ? out : null;
}

// ---------- MP4/M4A ----------
async function parseMP4(file) {
  const out = {};
  const read = async (start, len) => new Uint8Array(await file.slice(start, start + len).arrayBuffer());
  // 1) نلاقي موضع moov المطلق: أول ٣ ميجا، ولو مش موجود نفتش آخر ٣ ميجا
  let moovAt = -1; let moovLen = 0;
  const scan = (buf, base) => {
    let o = 0;
    while (o + 8 <= buf.length) {
      let sz = u32(buf, o); let hdr = 8;
      if (sz === 1) { hdr = 16; sz = Number((BigInt(u32(buf, o + 8)) << 32n) | BigInt(u32(buf, o + 12))); }
      if (sz < hdr) break;
      if (sig(buf, o + 4, 'moov')) { moovAt = base + o; moovLen = sz; return true; }
      o += sz;
    }
    return false;
  };
  const CAP = 3 * 1024 * 1024;
  const headChunk = await read(0, Math.min(file.size, CAP));
  if (!scan(headChunk, 0) && file.size > CAP) {
    // moov في الذيل: نفتش التوقيع بايت بايت ونتحقق إن الـ atom كله جوه القطعة
    const tailChunk = await read(Math.max(0, file.size - CAP), CAP);
    const base = file.size - tailChunk.length;
    for (let o = 4; o + 4 <= tailChunk.length; o++) {
      if (sig(tailChunk, o, 'moov')) {
        const sz = u32(tailChunk, o - 4);
        if (sz >= 8 && o - 4 + sz <= tailChunk.length && sz < 12 * 1024 * 1024) { moovAt = base + o - 4; moovLen = sz; break; }
      }
    }
  }
  if (moovAt < 0 || moovLen <= 8) return null;
  const mb = await read(moovAt, Math.min(moovLen, 12 * 1024 * 1024));
  const walk = (start, end, fn) => {
    let o = start;
    while (o + 8 <= end) {
      let sz = u32(mb, o); let hdr = 8;
      if (sz === 1) { hdr = 16; if (o + 16 > end) break; sz = Number((BigInt(u32(mb, o + 8)) << 32n) | BigInt(u32(mb, o + 12))); }
      if (sz < hdr || o + sz > end + 8) break;
      fn(String.fromCharCode(mb[o + 4], mb[o + 5], mb[o + 6], mb[o + 7]), o + hdr, Math.min(o + sz, end));
      o += sz;
    }
  };
  const TEXT = { '©nam': 'title', '©ART': 'artist', 'aART': 'artist', '©alb': 'album', '©day': 'year' };
  walk(8, mb.length, (ty, cs, ce) => {
    if (ty !== 'udta') return;
    walk(cs, ce, (ty2, cs2, ce2) => {
      if (ty2 !== 'meta') return;
      walk(cs2 + 4, ce2, (ty3, cs3, ce3) => {
        if (ty3 !== 'ilst') return;
        walk(cs3, ce3, (ty4, cs4, ce4) => {
          const key = TEXT[ty4];
          walk(cs4, ce4, (ty5, cs5, ce5) => {
            if (ty5 !== 'data' || ce5 - cs5 < 8) return;
            const kind = u32(mb, cs5);
            if (kind === 1 && key && !out[key]) out[key] = decStr(mb.subarray(cs5 + 8, ce5), 'utf-8');
            else if ((kind === 13 || kind === 14) && !out.picture) out.picture = new Blob([mb.subarray(cs5 + 8, ce5)], { type: kind === 13 ? 'image/jpeg' : 'image/png' });
          });
        });
      });
    });
  });
  return out.picture || out.title || out.artist ? out : null;
}

// ---------- FLAC ----------
async function parseFLAC(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (head.length < 4 || !sig(head, 0, 'fLaC')) return null;
  const out = {};
  let o = 4;
  for (let guard = 0; guard < 128; guard++) {
    const hb = new Uint8Array(await file.slice(o, o + 4).arrayBuffer());
    if (hb.length < 4) break;
    const last = hb[0] & 0x80; const type = hb[0] & 0x7f; const sz = u24(hb, 1);
    if (sz > file.size) break;
    if (type === 4) {
      const vb = new Uint8Array(await file.slice(o + 4, o + 4 + Math.min(sz, 1 << 20)).arrayBuffer());
      const dv = new DataView(vb.buffer, vb.byteOffset, vb.byteLength);
      let p = 0;
      if (p + 4 <= vb.length) {
        const vl = dv.getUint32(p, true); p += 4 + vl;
        if (p + 4 <= vb.length) {
          const cnt = dv.getUint32(p, true); p += 4;
          for (let i = 0; i < cnt && p + 4 <= vb.length; i++) {
            const l = dv.getUint32(p, true); p += 4;
            const s = decStr(vb.subarray(p, Math.min(p + l, vb.length)), 'utf-8'); p += l;
            const eq = s.indexOf('=');
            if (eq > 0) {
              const k = s.slice(0, eq).toUpperCase(); const v2 = s.slice(eq + 1);
              if (k === 'TITLE') out.title = out.title || v2;
              else if (k === 'ARTIST') out.artist = out.artist || v2;
              else if (k === 'ALBUM') out.album = out.album || v2;
              else if (k === 'DATE' || k === 'YEAR') out.year = out.year || v2;
            }
          }
        }
      }
    } else if (type === 6 && !out.picture) {
      const pb = new Uint8Array(await file.slice(o + 4, o + 4 + Math.min(sz, 6 * 1024 * 1024)).arrayBuffer());
      const dv = new DataView(pb.buffer, pb.byteOffset, pb.byteLength);
      if (pb.length > 32) {
        let p = 4; // block type (picture type)
        const ml = dv.getUint32(p); p += 4;
        const mime = decStr(pb.subarray(p, p + ml), 'latin1'); p += ml;
        const dl = dv.getUint32(p); p += 4 + dl;
        p += 16; // width, height, depth, colors
        if (p < pb.length && mime.startsWith('image/')) out.picture = new Blob([pb.subarray(p)], { type: mime });
      }
    }
    if (last) break;
    o += 4 + sz;
  }
  return out.picture || out.title || out.artist ? out : null;
}

export async function parseAudioTags(file) {
  try {
    if (!file || !file.size) return null;
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (head.length >= 4 && sig(head, 0, 'fLaC')) return await parseFLAC(file);
    if (head.length >= 8 && sig(head, 4, 'ftyp')) return await parseMP4(file);
    if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return await parseID3(file);
    return null; // ogg/opus/wav: ارجع لتحليل اسم الملف
  } catch { return null; }
}
