// Mikrofon-Überwachung: Pegelmessung, Auslösung, Aufnahme und Mustererkennung.
// Entspricht app/lauscher.py der PC-Version.
import * as A from "./analyse.js";
import { speicher } from "./speicher.js";

export const BLOCK = 2048;
export const STANDARD_EINSTELLUNGEN = {
  schwelle_ueber_grund: 10, // dB über dem Grundpegel
  min_pegel: -80,           // absolute Mindestschwelle in dBFS
  min_dauer: 0.15,          // s über der Schwelle, bevor ausgelöst wird
  vorlauf: 3,               // s Audio vor dem Auslösen
  nachlauf: 3,              // s Ruhe, bevor die Aufnahme endet
  max_dauer: 120,           // s, danach wird eine neue Aufnahme begonnen
  kalibrierung: 0,          // dB-Versatz für die Anzeige
  mustererkennung: true,    // zusätzlich bei Ähnlichkeit zu Referenzen auslösen
};
const GRUND_FENSTER = 120;
const LIVE_INTERVALL = 0.5;
const MAX_REF_LIVE = 20;

export class Lauscher {
  constructor(einst, beiEreignis) {
    this.e = { ...STANDARD_EINSTELLUNGEN, ...einst };
    this.beiEreignis = beiEreignis;
    this.sr = 48000;
    this.laeuft = false;
    this.fehler = "";
    this.refs = [];
    this.ereignisseSeitStart = 0;
    this.letzterBlock = 0;
    this.zuruecksetzen();
    setInterval(() => this.waechter(), 3000);
  }

  zuruecksetzen() {
    this.pegel = -120;
    this.grund = null;
    this.pegelHist = [];
    this.ring = [];
    this.ringS = 0;
    this.verlauf = [];
    this.bin = null;
    this.intervall = null;
    this.kandidat = null;
    this.aufnahme = null;
    this.letzterGrund = 0;
    this.letzterLive = 0;
    this.liveSperre = 0;
    this.liveTreffer = null;
    this.liveStart = 0;
    this.liveScores = {};
  }

  // ---------------------------------------------------------------- Steuerung
  async start(demo = false) {
    if (this.laeuft) return;
    this.fehler = "";
    try {
      const ctx = new AudioContext({ latencyHint: "playback" });
      await ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
      const knoten = new AudioWorkletNode(ctx, "sammler", { numberOfInputs: 1, numberOfOutputs: 0 });
      knoten.port.onmessage = (ev) => this.blockEmpfangen(ev.data);
      let quelle;
      if (demo) {
        quelle = ctx.createBufferSource();
        quelle.buffer = demoSignal(ctx);
        quelle.loop = true;
        quelle.start();
      } else {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        });
        quelle = ctx.createMediaStreamSource(this.stream);
        this.geraet = this.stream.getAudioTracks()[0]?.label || "Mikrofon";
        this.stream.getAudioTracks()[0].onended = () => { this.fehler = "Das Mikrofon wurde vom System beendet."; };
      }
      quelle.connect(knoten);
      if (ctx.state === "suspended") await ctx.resume();
      this.ctx = ctx;
      this.sr = ctx.sampleRate;
      this.zuruecksetzen();
      this.letzterBlock = performance.now();
      this.laeuft = true;
      this.demo = demo;
      if (demo) this.geraet = "Demo-Signal";
    } catch (ex) {
      this.fehler = ex.name === "NotAllowedError"
        ? "Mikrofonzugriff wurde verweigert. Bitte in den Browser-Einstellungen für diese Seite erlauben."
        : `Mikrofon konnte nicht gestartet werden: ${ex.message}`;
    }
  }

  async stop() {
    this.laeuft = false;
    if (this.aufnahme) this.aufnahmeBeenden();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  waechter() {
    if (!this.laeuft) return;
    if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {});
    this.unterbrochen = performance.now() - this.letzterBlock > 3000;
  }

  blockEmpfangen(block) {
    this.letzterBlock = performance.now();
    this.unterbrochen = false;
    if (this.laeuft) this.block(Date.now() / 1000, block);
  }

  // Verarbeitet ein Signal so, als käme es vom Mikrofon (für Tests).
  async simuliere(x, sr, startTs) {
    this.sr = sr;
    this.zuruecksetzen();
    for (let i = 0; i + BLOCK <= x.length; i += BLOCK) this.block(startTs + (i + BLOCK) / sr, x.subarray(i, i + BLOCK));
    if (this.aufnahme) this.aufnahmeBeenden();
    await this.speichernLaeuft;
  }

  schwelle() {
    return this.grund == null ? null : Math.max(this.grund + this.e.schwelle_ueber_grund, this.e.min_pegel);
  }

  // ---------------------------------------------------------------- Verarbeitung
  block(ts, block) {
    const sr = this.sr, dauer = block.length / sr;
    const L = A.pegelDb(block);
    this.pegel = L;

    // Ringpuffer für Vorlauf und Live-Vergleich
    this.ring.push([ts, block]);
    this.ringS += dauer;
    const behalten = Math.max(this.e.vorlauf, this.liveFenster()) + 1;
    while (this.ringS - this.ring[0][1].length / sr > behalten) this.ringS -= this.ring.shift()[1].length / sr;

    // Grundpegel: 20-%-Perzentil der letzten 2 Minuten, eingefroren während Aufnahmen
    this.pegelHist.push([ts, L]);
    while (this.pegelHist[0][0] < ts - GRUND_FENSTER) this.pegelHist.shift();
    if (!this.aufnahme && ts - this.letzterGrund >= 1) {
      this.letzterGrund = ts;
      if (this.pegelHist[this.pegelHist.length - 1][0] - this.pegelHist[0][0] >= 3) {
        const s = this.pegelHist.map((p) => p[1]).sort((a, b) => a - b);
        this.grund = s[Math.floor(s.length * 0.2)];
      }
    }

    this.statistik(ts, L);
    if (this.grund == null) return;
    const schwelle = this.schwelle();
    const muster = this.liveVergleich(ts);

    if (!this.aufnahme) {
      if (L > schwelle) {
        if (!this.kandidat) this.kandidat = { ts: ts - dauer, s: 0 };
        this.kandidat.s += dauer;
        if (this.kandidat.s >= this.e.min_dauer) this.aufnahmeBeginnen(muster);
      } else this.kandidat = null;
      if (!this.aufnahme && muster) { this.kandidat = null; this.aufnahmeBeginnen(muster); }
    } else {
      const a = this.aufnahme;
      a.bloecke.push(block);
      if (L > schwelle - 3) a.zuletzt = ts;
      if (muster) a.muster.add(muster);
      if (ts - a.zuletzt >= this.e.nachlauf || ts - a.start >= this.e.max_dauer) this.aufnahmeBeenden();
    }
  }

  statistik(ts, L) {
    // 0,25-s-Werte für die Live-Kurve (2 Minuten)
    const b = this.bin;
    if (!b || ts - b.ts >= 0.25) {
      if (b) {
        this.verlauf.push([b.ts, A.energieMittelDb(b.w), Math.max(...b.w)]);
        if (this.verlauf.length > 480) this.verlauf.shift();
      }
      this.bin = { ts, w: [L] };
    } else b.w.push(L);
    // 10-s-Werte in den Speicher
    const start10 = ts - (ts % 10), iv = this.intervall;
    if (!iv || iv.ts !== start10) {
      if (iv && iv.w.length) speicher.pegelSpeichern({
        ts: iv.ts, leq: A.energieMittelDb(iv.w), lmax: Math.max(...iv.w), lmin: Math.min(...iv.w), grund: this.grund,
      });
      this.intervall = { ts: start10, w: [L] };
    } else iv.w.push(L);
  }

  // ---------------------------------------------------------------- Mustererkennung
  async referenzenNeuLaden() {
    this.refs = (await speicher.referenzen()).filter((r) => r.live).map((r) => {
      const S = { b: r.baender, f: r.frames, d: r.spek };
      const n = Math.min(S.f, A.sekundenZuFrames(MAX_REF_LIVE, r.sr));
      return { id: r.id, name: r.name, schwelle: r.schwelle, sr: r.sr, spek: A.ausschnitt(S, 0, n) };
    });
  }

  liveFenster() {
    if (!this.refs.length || !this.e.mustererkennung) return 0;
    return Math.max(...this.refs.map((r) => A.framesZuSekunden(r.spek.f, r.sr))) + 1;
  }

  liveVergleich(ts) {
    if (!this.refs.length || !this.e.mustererkennung) { this.liveScores = {}; return null; }
    if (ts - this.letzterLive < LIVE_INTERVALL) return this.liveTreffer;
    this.letzterLive = ts;
    this.liveTreffer = null;
    const gesamt = this.ring.reduce((a, r) => a + r[1].length, 0);
    const x = new Float32Array(gesamt);
    let o = 0;
    for (const [, b] of this.ring) { x.set(b, o); o += b.length; }
    const scores = {};
    for (const r of this.refs) {
      if (r.angepasst?.sr !== this.sr) r.angepasst = { sr: this.sr, S: A.anpassen(r.spek, r.sr, this.sr) };
      const n = Math.min(x.length, Math.round((A.framesZuSekunden(r.spek.f, r.sr) + 1) * this.sr));
      const [score, off] = A.aehnlichkeit(r.angepasst.S, A.spektrogramm(x.subarray(x.length - n), this.sr));
      scores[r.id] = score;
      // Fenster muss hörbar über dem Grundpegel liegen; kurz nach einer Aufnahme gesperrt.
      let lautest = -120;
      for (const [t, p] of this.pegelHist) if (t >= ts - n / this.sr && p > lautest) lautest = p;
      if (score >= r.schwelle && lautest > this.grund + 3 && ts >= this.liveSperre) {
        this.liveTreffer = r.name;
        this.liveStart = ts - n / this.sr + A.framesZuSekunden(off, this.sr);
      }
    }
    this.liveScores = scores;
    return this.liveTreffer;
  }

  // ---------------------------------------------------------------- Aufnahme
  aufnahmeBeginnen(muster) {
    const ersterTs = this.ring[0][0] - this.ring[0][1].length / this.sr;
    const start = this.kandidat ? this.kandidat.ts : Math.max(ersterTs, this.liveStart);
    this.aufnahme = {
      start,
      vorlauf: Math.max(0, start - ersterTs),
      bloecke: this.ring.map((r) => r[1]),
      zuletzt: this.ring[this.ring.length - 1][0],
      grund: this.grund,
      muster: new Set(muster ? [muster] : []),
      perPegel: this.pegel > this.schwelle(),
      sr: this.sr,
    };
    this.kandidat = null;
  }

  aufnahmeBeenden() {
    const a = this.aufnahme;
    this.aufnahme = null;
    this.liveSperre = a.zuletzt + this.liveFenster();
    this.ring = [];
    this.ringS = 0;
    this.ereignisseSeitStart++;
    this.speichernLaeuft = (this.speichernLaeuft || Promise.resolve())
      .then(() => this.speichern(a))
      .catch((ex) => { this.fehler = `Fehler beim Speichern: ${ex.message}`; });
  }

  async speichern(a) {
    const n = a.bloecke.reduce((s, b) => s + b.length, 0), x = new Float32Array(n);
    let o = 0;
    for (const b of a.bloecke) { x.set(b, o); o += b.length; }
    const sr = a.sr;
    const v0 = Math.floor(a.vorlauf * sr);
    const dauer = Math.max(a.zuletzt - a.start, BLOCK / sr);
    const aktiv = x.subarray(v0, Math.min(x.length, v0 + Math.floor(dauer * sr) + BLOCK));
    const pegel = [];
    for (let i = 0; i + BLOCK <= aktiv.length || i === 0; i += BLOCK) pegel.push(A.pegelDb(aktiv, i, Math.min(aktiv.length, i + BLOCK)));
    const spek = A.spektrogramm(x, sr);
    const treffer = {};
    for (const r of await speicher.referenzen()) {
      const [score, off] = A.aehnlichkeit(A.anpassen({ b: r.baender, f: r.frames, d: r.spek }, r.sr, sr), spek);
      treffer[r.id] = { score, offset_s: A.framesZuSekunden(off, sr) };
    }
    const e = {
      start: a.start,
      dauer: Math.round(dauer * 100) / 100,
      spitze_db: Math.max(...pegel),
      mittel_db: A.energieMittelDb(pegel),
      grund_db: a.grund,
      frequenz: A.dominanteFrequenz(aktiv, sr),
      ausloeser: a.perPegel ? "Pegel" : "Muster: " + [...a.muster].sort().join(", "),
      vorlauf: a.vorlauf,
      laenge: x.length / sr,
      notiz: "",
      markiert: 0,
      treffer,
    };
    e.id = await speicher.ereignisAnlegen(e, A.wavKodieren(x, sr));
    this.beiEreignis?.(e);
  }

  status() {
    const k = this.e.kalibrierung, s = this.schwelle();
    return {
      laeuft: this.laeuft,
      unterbrochen: this.laeuft && this.unterbrochen,
      geraet: this.geraet,
      samplerate: this.sr,
      fehler: this.fehler,
      pegel: this.pegel + k,
      grund: this.grund == null ? null : this.grund + k,
      schwelle: s == null ? null : s + k,
      nimmt_auf: !!this.aufnahme,
      verlauf: this.verlauf.map(([t, l, m]) => [t, l + k, m + k]),
      live_scores: this.liveScores,
    };
  }
}

// Testsignal: Rauschen, alle 20 s ein Brummen mit Klopfen, alle 35 s ein Pfeifen.
function demoSignal(ctx) {
  const sr = ctx.sampleRate, n = sr * 70, buf = ctx.createBuffer(1, n, sr), x = buf.getChannelData(0);
  let z = 12345;
  const zufall = () => ((z = (z * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) x[i] = zufall() * 0.005;
  for (const t0 of [5, 25, 45]) {
    for (let i = 0; i < sr * 2; i++) {
      const t = i / sr;
      x[Math.floor(t0 * sr) + i] += 0.05 * Math.sin(2 * Math.PI * 70 * t) * Math.exp(-t);
    }
    for (let k = 0; k < 4; k++) for (let i = 0; i < 800; i++) x[Math.floor((t0 + 0.3 + 0.4 * k) * sr) + i] += 0.2 * zufall() * Math.exp(-i / 150);
  }
  for (const t0 of [15, 50]) for (let i = 0; i < sr * 1.5; i++) x[Math.floor(t0 * sr) + i] += 0.05 * Math.sin((2 * Math.PI * 2500 * i) / sr);
  return buf;
}
