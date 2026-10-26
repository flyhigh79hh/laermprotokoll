// Lokaler Speicher im Browser (IndexedDB): Ereignisse, Audiodaten, Pegelverlauf, Referenzen.
const NAME = "laermprotokoll";
let dbPromise = null;

function oeffnen() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((ok, fehler) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("ereignisse", { keyPath: "id", autoIncrement: true }).createIndex("start", "start");
      db.createObjectStore("audio");
      db.createObjectStore("pegel", { keyPath: "ts" });
      db.createObjectStore("referenzen", { keyPath: "id", autoIncrement: true });
      db.createObjectStore("einstellungen");
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fehler(r.error);
  });
  return dbPromise;
}

async function tx(store, modus, fn) {
  const db = await oeffnen();
  return new Promise((ok, fehler) => {
    const t = db.transaction(store, modus);
    let ergebnis;
    const req = fn(t.objectStore(store));
    if (req) req.onsuccess = () => (ergebnis = req.result);
    t.oncomplete = () => ok(ergebnis);
    t.onerror = () => fehler(t.error);
    t.onabort = () => fehler(t.error);
  });
}

export const speicher = {
  ereignisAnlegen: (e, audio) => oeffnen().then((db) => new Promise((ok, fehler) => {
    const t = db.transaction(["ereignisse", "audio"], "readwrite");
    const r = t.objectStore("ereignisse").add(e);
    r.onsuccess = () => t.objectStore("audio").put(audio, r.result);
    t.oncomplete = () => ok(r.result);
    t.onerror = () => fehler(t.error);
  })),
  ereignisse: () => tx("ereignisse", "readonly", (s) => s.getAll()).then((l) => l.sort((a, b) => b.start - a.start)),
  ereignis: (id) => tx("ereignisse", "readonly", (s) => s.get(id)),
  ereignisSpeichern: (e) => tx("ereignisse", "readwrite", (s) => s.put(e)),
  audio: (id) => tx("audio", "readonly", (s) => s.get(id)),
  ereignisLoeschen: (id) => oeffnen().then((db) => new Promise((ok) => {
    const t = db.transaction(["ereignisse", "audio"], "readwrite");
    t.objectStore("ereignisse").delete(id); t.objectStore("audio").delete(id);
    t.oncomplete = ok;
  })),
  pegelSpeichern: (p) => tx("pegel", "readwrite", (s) => s.put(p)),
  pegel: (von, bis) => tx("pegel", "readonly", (s) => s.getAll(IDBKeyRange.bound(von, bis))),
  referenzen: () => tx("referenzen", "readonly", (s) => s.getAll()),
  referenzSpeichern: (r) => tx("referenzen", "readwrite", (s) => s.put(r)),
  referenzLoeschen: (id) => tx("referenzen", "readwrite", (s) => s.delete(id)),
  einstellungen: () => tx("einstellungen", "readonly", (s) => s.get("e")),
  einstellungenSpeichern: (e) => tx("einstellungen", "readwrite", (s) => s.put(e, "e")),
};

// Überwachte Stunden je Tagesstunde und je Tag (aus den 10-s-Pegelwerten).
export async function abdeckung(von, bis) {
  const stunden = {}, tage = {};
  for (const p of await speicher.pegel(von, bis)) {
    const d = new Date(p.ts * 1000), tag = d.toLocaleDateString("sv-SE");
    stunden[d.getHours()] = (stunden[d.getHours()] || 0) + 10 / 3600;
    tage[tag] = (tage[tag] || 0) + 10 / 3600;
  }
  return { stunden, tage };
}

// ------------------------------------------------------------------ ZIP (ohne Kompression)
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function zipErstellen(dateien) {
  const teile = [], zentral = [], enc = new TextEncoder();
  let offset = 0;
  for (const { name, daten } of dateien) {
    const bytes = daten instanceof Blob ? new Uint8Array(await daten.arrayBuffer()) : enc.encode(daten);
    const nameB = enc.encode(name), crc = crc32(bytes);
    const kopf = new DataView(new ArrayBuffer(30));
    kopf.setUint32(0, 0x04034b50, true); kopf.setUint16(4, 20, true); kopf.setUint16(6, 0x0800, true);
    kopf.setUint32(14, crc, true); kopf.setUint32(18, bytes.length, true); kopf.setUint32(22, bytes.length, true);
    kopf.setUint16(26, nameB.length, true);
    teile.push(kopf, nameB, bytes);
    const z = new DataView(new ArrayBuffer(46));
    z.setUint32(0, 0x02014b50, true); z.setUint16(4, 20, true); z.setUint16(6, 20, true); z.setUint16(8, 0x0800, true);
    z.setUint32(16, crc, true); z.setUint32(20, bytes.length, true); z.setUint32(24, bytes.length, true);
    z.setUint16(28, nameB.length, true); z.setUint32(42, offset, true);
    zentral.push(z, nameB);
    offset += 30 + nameB.length + bytes.length;
  }
  const zGroesse = zentral.reduce((a, t) => a + t.byteLength, 0);
  const ende = new DataView(new ArrayBuffer(22));
  ende.setUint32(0, 0x06054b50, true); ende.setUint16(8, dateien.length, true); ende.setUint16(10, dateien.length, true);
  ende.setUint32(12, zGroesse, true); ende.setUint32(16, offset, true);
  return new Blob([...teile, ...zentral, ende], { type: "application/zip" });
}
