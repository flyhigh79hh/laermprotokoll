// Signalanalyse: Pegel, Spektrogramm, Geräusch-Fingerabdruck und Ähnlichkeitssuche.
// Entspricht app/analyse.py der PC-Version.
export const N_FFT = 2048;
export const HOP = 1024;
export const N_BAENDER = 48;
const F_MIN = 25;
const F_MAX = 12000;

export function pegelDb(x, a = 0, b = x.length) {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return b > a ? 10 * Math.log10(s / (b - a) + 1e-20) : -120;
}

export function energieMittelDb(werte) {
  if (!werte.length) return -120;
  let s = 0;
  for (const w of werte) s += 10 ** (w / 10);
  return 10 * Math.log10(s / werte.length + 1e-12);
}

// ------------------------------------------------------------------ FFT (radix 2)
const fftCache = {};
function fftTabellen(n) {
  if (fftCache[n]) return fftCache[n];
  const bits = Math.log2(n), rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  const fenster = new Float32Array(n);
  for (let i = 0; i < n; i++) fenster[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return (fftCache[n] = { rev, cos, sin, fenster, re: new Float64Array(n), im: new Float64Array(n) });
}

// Leistungsspektrum (n/2+1 Werte) eines gefensterten Frames ab Position a.
function leistung(x, a, n, aus) {
  const t = fftTabellen(n), { rev, re, im } = t;
  for (let i = 0; i < n; i++) { const j = rev[i]; re[j] = (x[a + i] || 0) * t.fenster[i]; im[j] = 0; }
  for (let groesse = 2; groesse <= n; groesse <<= 1) {
    const halb = groesse >> 1, schritt = n / groesse;
    for (let i = 0; i < n; i += groesse) {
      for (let j = 0, k = 0; j < halb; j++, k += schritt) {
        const c = t.cos[k], s = t.sin[k], u = i + j, v = u + halb;
        const tr = re[v] * c - im[v] * s, ti = re[v] * s + im[v] * c;
        re[v] = re[u] - tr; im[v] = im[u] - ti; re[u] += tr; im[u] += ti;
      }
    }
  }
  for (let k = 0; k <= n / 2; k++) aus[k] = re[k] * re[k] + im[k] * im[k];
  return aus;
}

// ------------------------------------------------------------------ Filterbank
const fbCache = {};
// Dreiecksfilter auf logarithmischer Frequenzachse, dünn besetzt gespeichert.
export function filterbank(sr) {
  if (fbCache[sr]) return fbCache[sr];
  const fMax = Math.min(F_MAX, (sr / 2) * 0.95), nb = N_FFT / 2 + 1;
  const kanten = Array.from({ length: N_BAENDER + 2 }, (_, i) => F_MIN * (fMax / F_MIN) ** (i / (N_BAENDER + 1)));
  const binHz = sr / N_FFT, baender = [];
  for (let b = 0; b < N_BAENDER; b++) {
    const [lo, mi, hi] = [kanten[b], kanten[b + 1], kanten[b + 2]];
    let start = Math.max(0, Math.floor(lo / binHz)), ende = Math.min(nb - 1, Math.ceil(hi / binHz));
    let w = [];
    for (let k = start; k <= ende; k++) {
      const f = k * binHz;
      w.push(Math.max(0, Math.min((f - lo) / (mi - lo), (hi - f) / (hi - mi))));
    }
    let summe = w.reduce((a, c) => a + c, 0);
    if (summe === 0) { start = Math.round(mi / binHz); w = [1]; summe = 1; } // schmaler als ein Bin
    baender.push({ start, w: Float32Array.from(w, (v) => v / summe) });
  }
  return (fbCache[sr] = { baender, mitten: kanten.slice(1, -1) });
}

// Band-Spektrogramm in dB. Rückgabe {b, f, d}: d[band * f + frame]
export function spektrogramm(x, sr) {
  const n = Math.max(1, 1 + Math.floor((Math.max(x.length, N_FFT) - N_FFT) / HOP));
  const { baender } = filterbank(sr), p = new Float64Array(N_FFT / 2 + 1);
  const d = new Float32Array(N_BAENDER * n);
  for (let f = 0; f < n; f++) {
    leistung(x, f * HOP, N_FFT, p);
    for (let b = 0; b < N_BAENDER; b++) {
      const { start, w } = baender[b];
      let s = 0;
      for (let k = 0; k < w.length; k++) s += w[k] * p[start + k];
      d[b * n + f] = 10 * Math.log10(s + 1e-12);
    }
  }
  return { b: N_BAENDER, f: n, d };
}

// Frequenz mit der meisten Energie (über 20 Hz) im lautesten Viertel der Frames.
export function dominanteFrequenz(x, sr) {
  if (x.length < N_FFT) return 0;
  const n = 1 + Math.floor((x.length - N_FFT) / HOP);
  const energie = Array.from({ length: n }, (_, f) => pegelDb(x, f * HOP, f * HOP + N_FFT));
  const grenze = energie.slice().sort((a, b) => a - b)[Math.floor(n * 0.75)];
  const summe = new Float64Array(N_FFT / 2 + 1), p = new Float64Array(N_FFT / 2 + 1);
  for (let f = 0; f < n; f++) if (energie[f] >= grenze) {
    leistung(x, f * HOP, N_FFT, p);
    for (let k = 0; k < p.length; k++) summe[k] += p[k];
  }
  const binHz = sr / N_FFT;
  let best = 0;
  for (let k = Math.ceil(20 / binHz); k < summe.length; k++) if (summe[k] > summe[best] || best === 0) best = k;
  if (best > 0 && best < summe.length - 1) { // parabolische Interpolation
    const [a, b, c] = [summe[best - 1], summe[best], summe[best + 1]].map((v) => Math.log(v + 1e-20));
    const nenner = a - 2 * b + c;
    return (best + (nenner ? (0.5 * (a - c)) / nenner : 0)) * binHz;
  }
  return best * binHz;
}

// Spektrale Form je Frame: mittelwertfrei, Einheitslänge (lautstärkeunabhängig).
function form(S) {
  const { b, f, d } = S, out = new Float32Array(b * f);
  for (let j = 0; j < f; j++) {
    let m = 0;
    for (let i = 0; i < b; i++) m += d[i * f + j];
    m /= b;
    let q = 0;
    for (let i = 0; i < b; i++) { const v = d[i * f + j] - m; out[j * b + i] = v; q += v * v; }
    q = Math.sqrt(q) + 1e-9;
    for (let i = 0; i < b; i++) out[j * b + i] /= q;
  }
  return out; // frame-major: out[frame * b + band]
}

function formVektor(v) {
  const m = v.reduce((a, c) => a + c, 0) / v.length;
  const o = v.map((x) => x - m);
  const q = Math.sqrt(o.reduce((a, c) => a + c * c, 0)) + 1e-9;
  return o.map((x) => x / q);
}

// Schiebt die Referenz über das Ziel. Pro Position: 50 % zeitlicher Verlauf (mittlere
// Frame-Kosinusähnlichkeit) + 50 % Klangfarbe (Kosinus der gemittelten Spektren).
// Rückgabe [Score 0..1, Startframe des besten Treffers im Ziel]
export function aehnlichkeit(ref, ziel) {
  const tausch = ziel.f < ref.f;
  const [kurz, lang] = tausch ? [ziel, ref] : [ref, ziel];
  const b = kurz.b, nk = kurz.f, nl = lang.f, pos = nl - nk + 1;
  const K = form(kurz), L = form(lang);

  const kMittel = new Float64Array(b);
  for (let i = 0; i < b; i++) { let s = 0; for (let j = 0; j < nk; j++) s += kurz.d[i * nk + j]; kMittel[i] = s / nk; }
  const kProfil = formVektor(Array.from(kMittel));
  const kum = new Float64Array(b * (nl + 1));
  for (let i = 0; i < b; i++) for (let j = 0; j < nl; j++) kum[i * (nl + 1) + j + 1] = kum[i * (nl + 1) + j] + lang.d[i * nl + j];

  let best = -1, bestPos = 0;
  const fenster = new Array(b);
  for (let p = 0; p < pos; p++) {
    let verlauf = 0;
    for (let j = 0; j < nk; j++) {
      const ka = j * b, la = (p + j) * b;
      let s = 0;
      for (let i = 0; i < b; i++) s += K[ka + i] * L[la + i];
      verlauf += s;
    }
    verlauf /= nk;
    for (let i = 0; i < b; i++) fenster[i] = (kum[i * (nl + 1) + p + nk] - kum[i * (nl + 1) + p]) / nk;
    const fp = formVektor(fenster);
    let klang = 0;
    for (let i = 0; i < b; i++) klang += kProfil[i] * fp[i];
    const score = 0.5 * Math.min(1, Math.max(0, verlauf)) + 0.5 * Math.min(1, Math.max(0, klang));
    if (score > best) { best = score; bestPos = p; }
  }
  return [best, tausch ? 0 : bestPos];
}

export const framesZuSekunden = (f, sr) => (f * HOP) / sr;
export const sekundenZuFrames = (s, sr) => Math.round((s * sr) / HOP);

// Passt die Zeitachse eines Spektrogramms an eine andere Abtastrate an (Bänder sind in Hz
// definiert und daher gleich; nur die Frames pro Sekunde unterscheiden sich).
export function anpassen(S, srVon, srNach) {
  if (srVon === srNach) return S;
  const f = Math.max(2, Math.round((S.f * srNach) / srVon)), d = new Float32Array(S.b * f);
  for (let j = 0; j < f; j++) {
    const q = (j * (S.f - 1)) / (f - 1), a = Math.floor(q), b = Math.min(S.f - 1, a + 1), w = q - a;
    for (let i = 0; i < S.b; i++) d[i * f + j] = S.d[i * S.f + a] * (1 - w) + S.d[i * S.f + b] * w;
  }
  return { b: S.b, f, d };
}

export function ausschnitt(S, von, bis) {
  const f = bis - von, d = new Float32Array(S.b * f);
  for (let i = 0; i < S.b; i++) d.set(S.d.subarray(i * S.f + von, i * S.f + bis), i * f);
  return { b: S.b, f, d };
}

// ------------------------------------------------------------------ WAV
export function wavKodieren(x, sr) {
  const buf = new ArrayBuffer(44 + x.length * 2), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + x.length * 2, true); str(8, "WAVEfmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return new Blob([buf], { type: "audio/wav" });
}

export async function wavDekodieren(blob) {
  const v = new DataView(await blob.arrayBuffer());
  const sr = v.getUint32(24, true);
  let o = 12;
  while (o < v.byteLength - 8) {
    const id = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    const groesse = v.getUint32(o + 4, true);
    if (id === "data") {
      const n = Math.min(groesse, v.byteLength - o - 8) >> 1, x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = v.getInt16(o + 8 + i * 2, true) / 32768;
      return { x, sr };
    }
    o += 8 + groesse;
  }
  throw new Error("Ungültige WAV-Datei");
}
