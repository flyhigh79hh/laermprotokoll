import * as A from "./analyse.js";
import { Lauscher, STANDARD_EINSTELLUNGEN } from "./lauscher.js";
import { abdeckung, speicher, zipErstellen } from "./speicher.js";

// ------------------------------------------------------------------ Hilfen
const $ = (s) => document.querySelector(s);
const farbe = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const zahl = (v, s = 1) => (v == null || !isFinite(v) ? "–" : v.toLocaleString("de-DE", { minimumFractionDigits: s, maximumFractionDigits: s }));
const datum = (ts) => new Date(ts * 1000).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
const uhrzeit = (ts) => new Date(ts * 1000).toLocaleTimeString("de-DE");
const dauerText = (s) => {
  if (s < 60) return `${zahl(s, s < 10 ? 1 : 0)} s`;
  if (s < 3600) return `${zahl(s / 60, s < 600 ? 1 : 0)} min`;
  if (s < 86400) return `${zahl(s / 3600, 1)} h`;
  return `${zahl(s / 86400, 1)} Tage`;
};
const tagesbeginn = (tageZurueck) => {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - tageZurueck);
  return d.getTime() / 1000;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dateiname = (e) => {
  const d = new Date(e.start * 1000), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}_${e.id}.wav`;
};
const pause = () => new Promise((r) => setTimeout(r, 0));

function leinwand(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const h = +(canvas.dataset.h || (canvas.dataset.h = canvas.getAttribute("height")));
  const w = canvas.clientWidth;
  canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = "11px system-ui, sans-serif";
  return { ctx, w, h };
}

// Achsen + Gitter. Liefert Abbildungsfunktionen.
function achsen(ctx, w, h, x0, x1, y0, y1, opt = {}) {
  const r = { l: opt.links ?? 44, r: 10, o: 10, u: opt.unten ?? 22 };
  const X = (v) => r.l + ((v - x0) / (x1 - x0)) * (w - r.l - r.r);
  const Y = (v) => h - r.u - ((v - y0) / (y1 - y0)) * (h - r.o - r.u);
  ctx.strokeStyle = farbe("--gitter"); ctx.fillStyle = farbe("--leise"); ctx.lineWidth = 1;
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const t of opt.yTicks || []) {
    ctx.beginPath(); ctx.moveTo(r.l, Y(t[0])); ctx.lineTo(w - r.r, Y(t[0])); ctx.stroke();
    ctx.fillText(t[1], r.l - 6, Y(t[0]));
  }
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const t of opt.xTicks || []) {
    if (opt.xGitter) { ctx.beginPath(); ctx.moveTo(X(t[0]), r.o); ctx.lineTo(X(t[0]), h - r.u); ctx.stroke(); }
    ctx.fillText(t[1], X(t[0]), h - r.u + 5);
  }
  return { X, Y, r };
}

function dbTicks(lo, hi) {
  const schritt = hi - lo > 60 ? 20 : 10;
  const t = [];
  for (let v = Math.ceil(lo / schritt) * schritt; v <= hi; v += schritt) t.push([v, String(v)]);
  return t;
}

// ------------------------------------------------------------------ Zustand
const S = {
  tab: "live", ereignisse: [], referenzen: [], einst: { ...STANDARD_EINSTELLUNGEN },
  gewaehlt: null, spek: null, auswahl: null, suche: { aktiv: false }, refGewaehlt: false, wakeLock: null,
};
let lauscher;

// ------------------------------------------------------------------ Tabs
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => zeigeTab(b.dataset.tab)));
function zeigeTab(name) {
  S.tab = name;
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("aktiv", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + name));
  if (name === "protokoll") ladeProtokoll();
  if (name === "auswertung") ladeAuswertung();
  if (name === "einstellungen") ladeEinstellungen();
  if (name === "live") zeichneLive();
}
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (S.tab === "live") zeichneLive();
    if (S.tab === "protokoll" && S.spek) zeichneSpek();
    if (S.tab === "auswertung") ladeAuswertung();
  }, 150);
});

// ------------------------------------------------------------------ Start/Stopp, Wake Lock
async function startStop() {
  if (lauscher.laeuft) {
    await lauscher.stop();
    S.wakeLock?.release().catch(() => {}); S.wakeLock = null;
  } else {
    await lauscher.start(new URLSearchParams(location.search).has("demo"));
    if (lauscher.laeuft) {
      await bildschirmAnlassen();
      navigator.storage?.persist?.().catch(() => {});
    }
  }
  zeigeStatus();
}
$("#btn-start-stop").addEventListener("click", startStop);
$("#btn-start-gross").addEventListener("click", startStop);

async function bildschirmAnlassen() {
  try {
    if ("wakeLock" in navigator && !S.wakeLock) {
      S.wakeLock = await navigator.wakeLock.request("screen");
      S.wakeLock.addEventListener("release", () => (S.wakeLock = null));
    }
  } catch { /* z. B. Energiesparmodus */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && lauscher?.laeuft) {
    bildschirmAnlassen();
    lauscher.ctx?.resume().catch(() => {});
  }
});
window.addEventListener("beforeunload", (ev) => { if (lauscher?.laeuft) { ev.preventDefault(); ev.returnValue = ""; } });

$("#btn-dunkel").addEventListener("click", () => { $("#dunkel").hidden = false; });
$("#dunkel").addEventListener("click", () => { $("#dunkel").hidden = true; });

// ------------------------------------------------------------------ Status / Live
function statusSchleife() {
  zeigeStatus();
  if (S.tab === "live" && $("#dunkel").hidden && document.visibilityState === "visible") zeichneLive();
  setTimeout(statusSchleife, $("#dunkel").hidden ? 400 : 2000);
}

function zeigeStatus() {
  const s = lauscher.status();
  const p = $("#status-pille");
  if (s.nimmt_auf) { p.className = "pille auf"; p.textContent = "● Nimmt auf"; }
  else if (s.unterbrochen) { p.className = "pille warn"; p.textContent = "Unterbrochen"; }
  else if (s.laeuft) { p.className = "pille an"; p.textContent = s.grund == null ? "Misst Grundpegel …" : "Lauscht"; }
  else { p.className = "pille warn"; p.textContent = "Gestoppt"; }
  $("#btn-start-stop").textContent = s.laeuft ? "Stoppen" : "Lauschen starten";
  $("#btn-start-stop").className = s.laeuft ? "knopf zweit" : "knopf";
  $("#start-hinweis").hidden = s.laeuft;
  const f = $("#fehler"); f.hidden = !s.fehler; f.textContent = s.fehler || "";
  const w = $("#warnung");
  const warnung = s.unterbrochen
    ? "Es kommen keine Audiodaten an. Bitte die App im Vordergrund lassen und den Bildschirm nicht sperren."
    : s.laeuft && !S.wakeLock && "wakeLock" in navigator
      ? "Der Bildschirm wird eventuell automatisch ausgeschaltet – dann stoppt die Aufnahme. Bitte in den Android-Einstellungen die Bildschirm-Zeitüberschreitung verlängern oder 🌙 benutzen."
      : "";
  w.hidden = !warnung; w.textContent = warnung;
  const si = $("#suche-info");
  si.hidden = !S.suche.aktiv;
  if (S.suche.aktiv) si.textContent = `Durchsuche bisherige Aufnahmen nach „${S.suche.referenz}“ … ${S.suche.fertig} / ${S.suche.gesamt}`;
  if (!$("#dunkel").hidden) {
    $("#dk-status").textContent = s.nimmt_auf ? "● Nimmt auf" : s.laeuft ? "Lauscht" : "Gestoppt";
    $("#dk-status").className = s.nimmt_auf ? "auf" : "";
    $("#dk-pegel").textContent = s.laeuft ? zahl(s.pegel) + " dB" : "";
    const heute = tagesbeginn(0);
    $("#dk-info").textContent = `${S.ereignisse.filter((e) => e.start >= heute).length} Aufnahmen heute`;
  }
}

function zeichneLive() {
  const s = lauscher.status();
  const lo = -100, hi = 0, k = S.einst.kalibrierung || 0;
  const pos = (v) => `${Math.max(0, Math.min(100, ((v - k - lo) / (hi - lo)) * 100))}%`;
  $("#live-pegel").textContent = s.laeuft ? zahl(s.pegel) : "–";
  $("#meter-fuell").style.width = s.laeuft ? pos(s.pegel) : "0";
  $("#meter-grund").style.left = s.grund != null ? pos(s.grund) : "-10px";
  $("#meter-schwelle").style.left = s.schwelle != null ? pos(s.schwelle) : "-10px";
  $("#live-grund").textContent = s.grund != null ? zahl(s.grund) + " dB" : "–";
  $("#live-schwelle").textContent = s.schwelle != null ? zahl(s.schwelle) + " dB" : "–";
  $("#live-geraet").textContent = s.laeuft ? `${s.geraet} · ${s.samplerate} Hz` : "";
  const heute = tagesbeginn(0);
  $("#live-heute").textContent = S.ereignisse.filter((e) => e.start >= heute).length;
  zeigeMuster(s);

  const { ctx, w, h } = leinwand($("#live-chart"));
  const v = s.verlauf;
  const jetzt = v.length ? v[v.length - 1][0] : Date.now() / 1000;
  const werte = v.flatMap((x) => [x[1], x[2]]).concat([s.grund, s.schwelle].filter((x) => x != null));
  const y0 = Math.floor((Math.min(...werte, -60) - 5) / 10) * 10;
  const y1 = Math.ceil((Math.max(...werte, y0 + 30) + 5) / 10) * 10;
  const xt = [-120, -90, -60, -30, 0].map((d) => [jetzt + d, d === 0 ? "jetzt" : `${d} s`]);
  const { X, Y } = achsen(ctx, w, h, jetzt - 120, jetzt, y0, y1, { yTicks: dbTicks(y0, y1), xTicks: xt });
  const linie = (wert, f, breite) => {
    ctx.strokeStyle = f; ctx.lineWidth = breite; ctx.beginPath();
    v.forEach((x, i) => (i ? ctx.lineTo(X(x[0]), Y(x[wert])) : ctx.moveTo(X(x[0]), Y(x[wert]))));
    ctx.stroke();
  };
  const waagerecht = (wert, f) => {
    if (wert == null) return;
    ctx.strokeStyle = f; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(X(jetzt - 120), Y(wert)); ctx.lineTo(X(jetzt), Y(wert)); ctx.stroke(); ctx.setLineDash([]);
  };
  linie(2, farbe("--akzent-2"), 1);
  linie(1, farbe("--akzent"), 2);
  waagerecht(s.grund, farbe("--grund"));
  waagerecht(s.schwelle, farbe("--schwelle"));
}

function zeigeMuster(s) {
  const box = $("#live-muster");
  const live = S.referenzen.filter((r) => r.live);
  if (!S.referenzen.length) return;
  if (!live.length) { box.textContent = "Keine Referenz für die Live-Erkennung aktiviert (siehe Auswertung)."; return; }
  if (!S.einst.mustererkennung) { box.textContent = "Mustererkennung ist in den Einstellungen ausgeschaltet."; return; }
  box.innerHTML = live.map((r) => {
    const sc = s.live_scores[r.id];
    const p = sc == null ? 0 : Math.round(sc * 100);
    return `<div class="muster-zeile"><span>${esc(r.name)}</span>
      <div class="muster-balken"><i style="width:${p}%"></i><div class="marke" style="left:${r.schwelle * 100}%"></div></div>
      <b>${sc == null ? "–" : p + " %"}</b></div>`;
  }).join("") + `<div class="klein">Aktuelle Ähnlichkeit der letzten Sekunden; roter Strich = Auslöseschwelle.</div>`;
}

const audioUrls = new Map();
async function audioUrl(id) {
  if (!audioUrls.has(id)) {
    const blob = await speicher.audio(id);
    audioUrls.set(id, blob ? URL.createObjectURL(blob) : "");
  }
  return audioUrls.get(id);
}

async function zeigeLetzte() {
  const l = S.ereignisse.slice(0, 5), k = S.einst.kalibrierung || 0;
  const box = $("#live-letzte");
  box.innerHTML = l.length ? l.map((e) => `<div class="letzte">
      <b>${uhrzeit(e.start)}</b><span class="klein">${datum(e.start)}</span>
      <span>${dauerText(e.dauer)} · ${zahl(e.spitze_db + k)} dB · ${esc(e.ausloeser)}</span>
      <span class="spacer"></span>
      <audio controls preload="none" data-id="${e.id}"></audio></div>`).join("")
    : `<div class="klein">Noch keine Aufnahmen.</div>`;
  for (const au of box.querySelectorAll("audio")) au.src = await audioUrl(+au.dataset.id);
}

// ------------------------------------------------------------------ Daten
async function ladeEreignisse() {
  [S.ereignisse, S.referenzen] = await Promise.all([speicher.ereignisse(), speicher.referenzen()]);
  fuelleReferenzAuswahl();
}

async function neuesEreignis() {
  await ladeEreignisse();
  zeigeLetzte();
  if (S.tab === "protokoll") zeigeTabelle();
}

function fuelleReferenzAuswahl() {
  for (const [sel, leer] of [["#f-referenz", "– keine –"], ["#a-referenz", "Alle Aufnahmen"]]) {
    const el = $(sel), alt = el.value;
    el.innerHTML = `<option value="">${leer}</option>` +
      S.referenzen.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
    if (sel === "#a-referenz" && !S.refGewaehlt && S.referenzen.length) {
      el.value = S.referenzen[S.referenzen.length - 1].id; S.refGewaehlt = true;
    } else if ([...el.options].some((o) => o.value === alt)) el.value = alt;
  }
  $("#f-min-box").hidden = !$("#f-referenz").value;
  $("#a-min-box").hidden = !$("#a-referenz").value;
}

function gefiltert(zeitraumSel, refSel, minSel, nurMarkiert) {
  const tage = +$(zeitraumSel).value;
  const von = tage ? tagesbeginn(tage - 1) : 0;
  const rid = $(refSel).value, min = +$(minSel).value / 100;
  return S.ereignisse.filter((e) => e.start >= von
    && (!nurMarkiert || e.markiert)
    && (!rid || (e.treffer[rid] && e.treffer[rid].score >= min)));
}

// Durchsucht alle gespeicherten Aufnahmen nach einer Referenz (im Hintergrund, mit Pausen).
async function sucheStarten(ref) {
  if (S.suche.aktiv) return;
  const liste = await speicher.ereignisse();
  const R = { b: ref.baender, f: ref.frames, d: ref.spek };
  S.suche = { aktiv: true, fertig: 0, gesamt: liste.length, referenz: ref.name };
  try {
    for (const e of liste) {
      const blob = await speicher.audio(e.id);
      if (blob) {
        const { x, sr } = await A.wavDekodieren(blob);
        {
          const [score, off] = A.aehnlichkeit(A.anpassen(R, ref.sr, sr), A.spektrogramm(x, sr));
          const akt = await speicher.ereignis(e.id);
          if (akt) { akt.treffer[ref.id] = { score, offset_s: A.framesZuSekunden(off, sr) }; await speicher.ereignisSpeichern(akt); }
        }
      }
      S.suche.fertig++;
      await pause();
    }
  } finally {
    S.suche.aktiv = false;
    await ladeEreignisse();
    if (S.tab === "protokoll") zeigeTabelle();
    if (S.tab === "auswertung") ladeAuswertung();
  }
}

// ------------------------------------------------------------------ Protokoll
for (const id of ["#f-zeitraum", "#f-referenz", "#f-markiert"]) $(id).addEventListener("change", () => { fuelleReferenzAuswahl(); zeigeTabelle(); });
$("#f-min").addEventListener("input", () => { $("#f-min-wert").textContent = $("#f-min").value + " %"; zeigeTabelle(); });

async function ladeProtokoll() { await ladeEreignisse(); zeigeTabelle(); }

function zeigeTabelle() {
  const rid = $("#f-referenz").value;
  const k = S.einst.kalibrierung || 0;
  const liste = gefiltert("#f-zeitraum", "#f-referenz", "#f-min", $("#f-markiert").checked);
  $("#th-aehnl").textContent = rid ? "Ähnlichkeit" : "";
  $("#tabelle-leer").hidden = liste.length > 0;
  const ref = S.referenzen.find((r) => r.id == rid);
  $("#tabelle tbody").innerHTML = liste.map((e) => {
    const t = rid && e.treffer[rid];
    const p = t ? Math.round(t.score * 100) : null;
    return `<tr data-id="${e.id}" class="${S.gewaehlt?.id === e.id ? "gewaehlt" : ""}">
      <td>${e.markiert ? "★" : ""}</td><td>${datum(e.start)}</td><td><b>${uhrzeit(e.start)}</b></td>
      <td>${dauerText(e.dauer)}</td><td>${zahl(e.spitze_db + k)} dB</td><td>${zahl(e.mittel_db + k)} dB</td>
      <td>${zahl(e.frequenz, 0)} Hz</td><td>${esc(e.ausloeser)}</td>
      <td>${rid ? (p == null ? "–" : `<span class="balken ${ref && t.score >= ref.schwelle ? "hoch" : ""}"><i style="width:${p}%"></i></span>${p} %`) : ""}</td>
      <td class="notiz">${esc(e.notiz)}</td></tr>`;
  }).join("");
}

$("#tabelle tbody").addEventListener("click", (ev) => {
  const tr = ev.target.closest("tr"); if (tr) oeffneDetail(+tr.dataset.id);
});

async function oeffneDetail(id) {
  const e = S.ereignisse.find((x) => x.id === id); if (!e) return;
  S.gewaehlt = e;
  zeigeTabelle();
  const k = S.einst.kalibrierung || 0;
  $("#detail").hidden = false;
  $("#d-titel").textContent = `${datum(e.start)}, ${uhrzeit(e.start)} Uhr`;
  $("#d-werte").textContent = `Dauer ${dauerText(e.dauer)} · Spitze ${zahl(e.spitze_db + k)} dB · Mittel ${zahl(e.mittel_db + k)} dB · Grundpegel ${zahl(e.grund_db != null ? e.grund_db + k : null)} dB · dominante Frequenz ${zahl(e.frequenz, 0)} Hz · Auslöser: ${e.ausloeser}`;
  $("#d-notiz").value = e.notiz || "";
  $("#d-markieren").textContent = e.markiert ? "★ Markiert" : "☆ Markieren";
  $("#d-audio").src = await audioUrl(e.id);
  S.spek = null; zeichneSpek();
  $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
  const blob = await speicher.audio(e.id);
  const { x, sr } = await A.wavDekodieren(blob);
  const sp = A.spektrogramm(x, sr);
  let oben = -200;
  const sortiert = Float32Array.from(sp.d).sort();
  oben = sortiert[Math.floor(sortiert.length * 0.995)];
  const unten = oben - 70, bild = new Uint8Array(sp.d.length);
  for (let i = 0; i < sp.d.length; i++) bild[i] = Math.max(0, Math.min(255, ((sp.d[i] - unten) / (oben - unten)) * 255));
  const n = 1200, stueck = Math.max(1, Math.floor(x.length / n)), huelle = [];
  for (let i = 0; i + stueck <= x.length; i += stueck) {
    let m = 0; for (let j = i; j < i + stueck; j++) m = Math.max(m, Math.abs(x[j])); huelle.push(m);
  }
  S.spek = { baender: sp.b, frames: sp.f, bild, dauer: x.length / sr, frequenzen: A.filterbank(sr).mitten, huelle, sr, roh: sp };
  S.auswahl = [Math.max(0, e.vorlauf - 0.2), Math.min(S.spek.dauer, e.vorlauf + e.dauer + 0.3)];
  zeigeAuswahl();
  zeichneSpek();
}

const FARBVERLAUF = [[0, [8, 8, 30]], [0.3, [70, 20, 110]], [0.55, [190, 50, 80]], [0.8, [250, 150, 30]], [1, [252, 250, 180]]];
const PALETTE = Array.from({ length: 256 }, (_, i) => {
  const t = i / 255; let j = 0;
  while (FARBVERLAUF[j + 1][0] < t) j++;
  const [t0, a] = FARBVERLAUF[j], [t1, b] = FARBVERLAUF[j + 1], f = (t - t0) / (t1 - t0);
  return a.map((v, n) => Math.round(v + (b[n] - v) * f));
});

let spekBild = null;
function zeichneSpek() {
  const c = $("#d-spek");
  const { ctx, w, h } = leinwand(c);
  const sp = S.spek;
  ctx.fillStyle = farbe("--bg"); ctx.fillRect(0, 0, w, h);
  if (!sp) { ctx.fillStyle = farbe("--leise"); ctx.fillText("Berechne Spektrogramm …", 50, 20); return; }
  const L = 48, U = 20, wellenH = 56, spekO = wellenH + 6, spekH = h - spekO - U, breite = w - L - 8;
  if (!spekBild || spekBild.quelle !== sp) {
    const oc = document.createElement("canvas"); oc.width = sp.frames; oc.height = sp.baender;
    const oct = oc.getContext("2d"), img = oct.createImageData(sp.frames, sp.baender);
    for (let b = 0; b < sp.baender; b++) for (let f = 0; f < sp.frames; f++) {
      const p = PALETTE[sp.bild[b * sp.frames + f]], i = ((sp.baender - 1 - b) * sp.frames + f) * 4;
      img.data[i] = p[0]; img.data[i + 1] = p[1]; img.data[i + 2] = p[2]; img.data[i + 3] = 255;
    }
    oct.putImageData(img, 0, 0);
    spekBild = { quelle: sp, canvas: oc };
  }
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(spekBild.canvas, L, spekO, breite, spekH);
  ctx.fillStyle = farbe("--akzent");
  const hu = sp.huelle, mx = Math.max(...hu, 1e-4), mitte = wellenH / 2;
  for (let i = 0; i < hu.length; i++) {
    const x = L + (i / hu.length) * breite, a = (hu[i] / mx) * (wellenH / 2 - 2);
    ctx.fillRect(x, mitte - a, Math.max(1, breite / hu.length), a * 2);
  }
  ctx.fillStyle = farbe("--leise"); ctx.textAlign = "right"; ctx.textBaseline = "middle";
  const fr = sp.frequenzen, nf = fr.length;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    if (f < fr[0] || f > fr[nf - 1]) continue;
    const pos = Math.log(f / fr[0]) / Math.log(fr[nf - 1] / fr[0]);
    if (pos > 0.93) continue;
    ctx.fillText(f >= 1000 ? f / 1000 + "k" : f, L - 6, spekO + spekH - pos * spekH);
  }
  ctx.fillText("Hz", L - 6, spekO + 4);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  const schritt = sp.dauer > 60 ? 10 : sp.dauer > 20 ? 5 : sp.dauer > 8 ? 2 : 1;
  for (let t = 0; t <= sp.dauer; t += schritt) ctx.fillText(t + " s", L + (t / sp.dauer) * breite, h - U + 5);
  const X = (t) => L + (t / sp.dauer) * breite;
  if (S.auswahl) {
    const [a, b] = S.auswahl;
    ctx.fillStyle = "rgba(96,165,250,0.18)"; ctx.fillRect(X(a), 0, X(b) - X(a), h - U);
    ctx.strokeStyle = farbe("--akzent"); ctx.lineWidth = 1.5;
    ctx.strokeRect(X(a), 0.5, X(b) - X(a), h - U - 1);
  }
  const au = $("#d-audio");
  if (au.currentTime > 0) {
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(au.currentTime), 0); ctx.lineTo(X(au.currentTime), h - U); ctx.stroke();
  }
  S.spekGeo = { L, breite };
}

(function spekZeiger() {
  const c = $("#d-spek");
  let start = null, bewegt = false;
  const zeit = (ev) => {
    const r = c.getBoundingClientRect(), g = S.spekGeo;
    return Math.max(0, Math.min(S.spek.dauer, ((ev.clientX - r.left - g.L) / g.breite) * S.spek.dauer));
  };
  c.addEventListener("pointerdown", (ev) => {
    if (!S.spek) return;
    start = zeit(ev); bewegt = false; c.setPointerCapture(ev.pointerId);
  });
  c.addEventListener("pointermove", (ev) => {
    if (start == null) return;
    const t = zeit(ev);
    if (Math.abs(t - start) > S.spek.dauer / 100) bewegt = true;
    if (bewegt) { S.auswahl = [Math.min(start, t), Math.max(start, t)]; zeigeAuswahl(); zeichneSpek(); }
  });
  c.addEventListener("pointerup", () => {
    if (start == null) return;
    if (!bewegt) { const au = $("#d-audio"); au.currentTime = start; au.play(); }
    start = null;
  });
  const schleife = () => { if (!$("#d-audio").paused && S.spek) zeichneSpek(); requestAnimationFrame(schleife); };
  requestAnimationFrame(schleife);
})();

function zeigeAuswahl() {
  const [a, b] = S.auswahl;
  $("#d-auswahl").textContent = `Auswahl ${zahl(a, 1)}–${zahl(b, 1)} s (${zahl(b - a, 1)} s)`;
}

$("#d-schliessen").addEventListener("click", () => { $("#detail").hidden = true; $("#d-audio").pause(); S.gewaehlt = null; zeigeTabelle(); });
$("#d-notiz").addEventListener("change", async () => {
  const e = await speicher.ereignis(S.gewaehlt.id);
  e.notiz = $("#d-notiz").value; await speicher.ereignisSpeichern(e);
  S.gewaehlt.notiz = e.notiz; zeigeTabelle();
});
$("#d-markieren").addEventListener("click", async () => {
  const e = await speicher.ereignis(S.gewaehlt.id);
  e.markiert = e.markiert ? 0 : 1; await speicher.ereignisSpeichern(e);
  S.gewaehlt.markiert = e.markiert;
  $("#d-markieren").textContent = e.markiert ? "★ Markiert" : "☆ Markieren"; zeigeTabelle();
});
$("#d-loeschen").addEventListener("click", async () => {
  if (!confirm("Diese Aufnahme endgültig löschen?")) return;
  await speicher.ereignisLoeschen(S.gewaehlt.id);
  $("#detail").hidden = true; S.gewaehlt = null; await ladeProtokoll();
});
$("#d-teilen").addEventListener("click", async () => {
  const e = S.gewaehlt, blob = await speicher.audio(e.id);
  const datei = new File([blob], dateiname(e), { type: "audio/wav" });
  const text = `Geräusch vom ${datum(e.start)}, ${uhrzeit(e.start)} Uhr – ${dauerText(e.dauer)}, ${zahl(e.frequenz, 0)} Hz`;
  if (navigator.canShare?.({ files: [datei] })) navigator.share({ files: [datei], text }).catch(() => {});
  else herunterladen(datei, datei.name);
});
$("#d-ref").addEventListener("click", async () => {
  const [a, b] = S.auswahl, sp = S.spek;
  if (b - a < 0.15) { alert("Bitte einen längeren Bereich markieren (mind. 0,15 s)."); return; }
  const von = Math.floor((a * sp.sr) / A.HOP), bis = Math.max(von + 2, Math.ceil((b * sp.sr) / A.HOP));
  const aus = A.ausschnitt(sp.roh, von, Math.min(bis, sp.roh.f));
  const ref = {
    name: $("#d-ref-name").value || "Geräusch", ereignis_id: S.gewaehlt.id, start_s: a, ende_s: b,
    schwelle: 0.8, live: 1, erstellt: Date.now() / 1000, sr: sp.sr, baender: aus.b, frames: aus.f, spek: aus.d,
  };
  ref.id = await speicher.referenzSpeichern(ref);
  await lauscher.referenzenNeuLaden();
  await ladeEreignisse();
  $("#f-referenz").value = ref.id;
  fuelleReferenzAuswahl(); zeigeTabelle();
  alert("Referenzgeräusch gespeichert. Alle bisherigen Aufnahmen werden jetzt danach durchsucht; neue Aufnahmen werden automatisch verglichen.");
  sucheStarten(ref);
});

// ------------------------------------------------------------------ Auswertung
for (const id of ["#a-referenz", "#a-zeitraum", "#a-tag"]) $(id).addEventListener("change", () => { fuelleReferenzAuswahl(); ladeAuswertung(); });
$("#a-min").addEventListener("input", () => { $("#a-min-wert").textContent = $("#a-min").value + " %"; ladeAuswertung(); });
$("#a-tag").value = new Date().toLocaleDateString("sv-SE");

function zeigeReferenzen() {
  const box = $("#ref-liste");
  if (!S.referenzen.length) {
    box.innerHTML = `<div class="klein">Noch keine Referenz. So geht's: Im Reiter <b>Protokoll</b> eine Aufnahme mit dem gesuchten Geräusch öffnen, den Bereich im Spektrogramm markieren und „Als Referenzgeräusch speichern“ tippen. Danach werden alle Aufnahmen nach diesem Geräusch durchsucht und die App lauscht gezielt danach.</div>`;
    return;
  }
  box.innerHTML = S.referenzen.map((r) => `<div class="ref" data-id="${r.id}">
    <b>${esc(r.name)}</b><span class="klein">${zahl(r.ende_s - r.start_s, 1)} s aus Aufnahme #${r.ereignis_id}</span>
    <label class="klein">Auslöseschwelle <input type="range" min="50" max="99" value="${Math.round(r.schwelle * 100)}" data-f="schwelle"> <b>${Math.round(r.schwelle * 100)} %</b></label>
    <label class="klein"><input type="checkbox" data-f="live" ${r.live ? "checked" : ""}> live lauschen</label>
    <span class="spacer"></span>
    <button class="knopf zweit" data-a="suchen">Erneut durchsuchen</button>
    <button class="knopf gefahr" data-a="loeschen">Löschen</button></div>`).join("");
}
$("#ref-liste").addEventListener("input", (ev) => {
  if (ev.target.dataset.f === "schwelle") ev.target.nextElementSibling.textContent = ev.target.value + " %";
});
$("#ref-liste").addEventListener("change", async (ev) => {
  const f = ev.target.dataset.f; if (!f) return;
  const ref = S.referenzen.find((r) => r.id === +ev.target.closest(".ref").dataset.id);
  ref[f] = f === "live" ? (ev.target.checked ? 1 : 0) : ev.target.value / 100;
  await speicher.referenzSpeichern(ref);
  await lauscher.referenzenNeuLaden();
  ladeAuswertung();
});
$("#ref-liste").addEventListener("click", async (ev) => {
  const a = ev.target.dataset.a; if (!a) return;
  const ref = S.referenzen.find((r) => r.id === +ev.target.closest(".ref").dataset.id);
  if (a === "suchen") sucheStarten(ref);
  if (a === "loeschen" && confirm("Referenzgeräusch löschen? Die Aufnahmen bleiben erhalten.")) {
    await speicher.referenzLoeschen(ref.id);
    await lauscher.referenzenNeuLaden();
    ladeAuswertung();
  }
});

let auswertungLaeuft = false;
async function ladeAuswertung() {
  if (auswertungLaeuft) return;
  auswertungLaeuft = true;
  try {
    await ladeEreignisse();
    zeigeReferenzen();
    const liste = gefiltert("#a-zeitraum", "#a-referenz", "#a-min", false).slice().sort((a, b) => a.start - b.start);
    const tage = +$("#a-zeitraum").value;
    const von = tage ? tagesbeginn(tage - 1) : (S.ereignisse.length ? Math.min(...S.ereignisse.map((e) => e.start)) : Date.now() / 1000);
    const bis = Date.now() / 1000;
    const abd = await abdeckung(von, bis);
    const abstaende = liste.slice(1).map((e, i) => e.start - liste[i].start);
    zeigeKennzahlen(liste, abstaende, abd);
    zeichneZeitstrahl(liste, von, bis, abd);
    zeichneStunden(liste, abd);
    zeichneAbstaende(abstaende);
    await zeichneTagespegel(liste);
  } finally { auswertungLaeuft = false; }
}

function statistik(werte) {
  const n = werte.length; if (!n) return null;
  const m = werte.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(werte.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  const s = werte.slice().sort((a, b) => a - b);
  return { n, mittel: m, sd, cv: sd / m, median: s[Math.floor(n / 2)] };
}

function zeigeKennzahlen(liste, abst, abd) {
  const stdUeberwacht = Object.values(abd.stunden).reduce((a, b) => a + b, 0);
  const st = statistik(abst);
  const proTag = stdUeberwacht > 0 ? (liste.length / stdUeberwacht) * 24 : null;
  const kachel = (titel, wert, sub = "") => `<div class="karte"><div class="label">${titel}</div><b>${wert}</b><span class="klein">${sub}</span></div>`;
  $("#a-kacheln").innerHTML =
    kachel("Ereignisse", liste.length, $("#a-referenz").value ? "ähnlich zur Referenz" : "alle Aufnahmen") +
    kachel("Überwachte Zeit", dauerText(stdUeberwacht * 3600)) +
    kachel("Häufigkeit", proTag == null ? "–" : zahl(proTag, 1) + " / Tag", "bezogen auf überwachte Zeit") +
    kachel("Typischer Abstand", st ? dauerText(st.median) : "–", st ? "Median" : "") +
    kachel("Regelmäßigkeit", st && st.n >= 3 ? zahl(st.cv, 2) : "–", "Variationskoeffizient (0 = exakt regelmäßig)");

  const p = [];
  if (liste.length < 4) {
    p.push("Für eine Aussage über den zeitlichen Verlauf sind noch zu wenige Ereignisse vorhanden. Lassen Sie die App einige Tage laufen.");
  } else {
    if (st.cv < 0.35) p.push(`<b>Regelmäßig:</b> Das Geräusch tritt recht gleichmäßig etwa alle <b>${dauerText(st.median)}</b> auf (Schwankung ± ${dauerText(st.sd)}). Das spricht für einen zyklischen Vorgang, z. B. Brennerstarts/Takten, Pumpen- oder Ventilzyklen.`);
    else if (st.cv < 0.75) p.push(`<b>Teilweise regelmäßig:</b> Typischer Abstand etwa ${dauerText(st.median)}, aber mit deutlicher Schwankung. Möglicherweise an einen Regelvorgang gekoppelt, der von Außen-/Raumtemperatur oder Warmwasserbedarf abhängt.`);
    else p.push(`<b>Unregelmäßig:</b> Die Abstände schwanken stark (typisch ${dauerText(st.median)}). Das Muster wirkt eher zufällig bzw. ereignisgesteuert, z. B. durch Warmwasserzapfung, Thermostatventile oder Temperaturänderungen (Ausdehnungsgeräusche).`);
    const zaehl = Array(24).fill(0); liste.forEach((e) => zaehl[new Date(e.start * 1000).getHours()]++);
    const std = Array.from({ length: 24 }, (_, h) => abd.stunden[h] || 0);
    const gesamtStd = std.reduce((a, b) => a + b, 0);
    if (liste.length >= 12 && gesamtStd > 0) {
      let chi = 0, df = -1;
      for (let h = 0; h < 24; h++) if (std[h] > 0) { const erw = (liste.length * std[h]) / gesamtStd; chi += (zaehl[h] - erw) ** 2 / erw; df++; }
      const krit = df + 2.33 * Math.sqrt(2 * df); // ~ 99-%-Quantil (Näherung)
      const rate = zaehl.map((z, h) => (std[h] ? z / std[h] : 0));
      const top = rate.map((r, h) => [r, h]).sort((a, b) => b[0] - a[0]).filter((x) => x[0] > 0).slice(0, 4).map((x) => x[1]).sort((a, b) => a - b);
      if (chi > krit) p.push(`<b>Tageszeit-Häufung:</b> Das Geräusch tritt bevorzugt zu bestimmten Uhrzeiten auf, am häufigsten gegen ${top.map((h) => `${h}–${h + 1} Uhr`).join(", ")}. Vergleichen Sie diese Zeiten mit dem Heizprogramm (Nachtabsenkung, Aufheizphase morgens, Warmwasserbereitung, Legionellenschaltung).`);
      else p.push("<b>Keine deutliche Tageszeit-Häufung:</b> Die Ereignisse verteilen sich ohne auffälliges Muster über die überwachten Stunden.");
    } else p.push("Für eine Aussage zur Tageszeit-Häufung werden mindestens 12 Ereignisse benötigt.");
  }
  if (!$("#a-referenz").value) p.push(`<span class="klein">Hinweis: Ausgewertet werden alle Aufnahmen – auch andere Geräusche. Legen Sie ein Referenzgeräusch fest, um nur das gesuchte Geräusch zu betrachten.</span>`);
  $("#a-fazit").innerHTML = p.map((x) => `<p>${x}</p>`).join("");
}

function zeichneZeitstrahl(liste, von, bis, abd) {
  const { ctx, w, h } = leinwand($("#a-zeitstrahl"));
  const t0 = new Date(von * 1000); t0.setHours(0, 0, 0, 0);
  const tag0 = t0.getTime() / 1000, nTage = Math.max(1, Math.ceil((bis - tag0) / 86400));
  const xt = [], schritt = Math.ceil(nTage / Math.max(2, Math.floor(w / 55)));
  for (let d = 0; d < nTage; d += schritt) xt.push([d + 0.5, new Date((tag0 + d * 86400 + 43200) * 1000).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })]);
  const yt = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((s) => [s, String(s).padStart(2, "0") + ":00"]);
  const { X, Y } = achsen(ctx, w, h, 0, nTage, 24, 0, { yTicks: yt, xTicks: xt, links: 48 });
  ctx.fillStyle = farbe("--gitter");
  for (let d = 0; d < nTage; d++) {
    const key = new Date((tag0 + d * 86400 + 43200) * 1000).toLocaleDateString("sv-SE");
    if (!abd.tage[key]) ctx.fillRect(X(d), Y(0), X(d + 1) - X(d), Y(24) - Y(0));
  }
  const k = S.einst.kalibrierung || 0;
  const pegel = liste.map((e) => e.spitze_db);
  const lo = Math.min(...pegel), hi = Math.max(...pegel);
  ctx.fillStyle = farbe("--akzent"); ctx.globalAlpha = 0.75;
  for (const e of liste) {
    const d = new Date(e.start * 1000);
    const tagIdx = Math.floor((e.start - tag0) / 86400 + 1e-9);
    const std = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
    const r = 3 + (hi > lo ? ((e.spitze_db - lo) / (hi - lo)) * 4 : 1.5);
    const x = X(tagIdx + 0.5 + (((e.id * 7919) % 100) / 100 - 0.5) * 0.5);
    ctx.beginPath(); ctx.arc(x, Y(std), r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = farbe("--leise"); ctx.textAlign = "right"; ctx.textBaseline = "top";
  if (liste.length) ctx.fillText(`Punktgröße = Lautstärke (${zahl(lo + k, 0)} bis ${zahl(hi + k, 0)} dB) · grau = nicht überwacht`, w - 10, 0);
}

function balken(canvas, werte, labels, opt = {}) {
  const { ctx, w, h } = leinwand(canvas);
  const mx = Math.max(...werte, 1e-9), n = werte.length;
  const yt = [0, mx / 2, mx].map((v) => [v, opt.fmt ? opt.fmt(v) : zahl(v, 0)]);
  const jedes = Math.ceil(n / (w / 40));
  const xt = labels.map((l, i) => [i + 0.5, i % jedes === 0 ? l : ""]);
  const { X, Y } = achsen(ctx, w, h, 0, n, 0, mx * 1.05, { yTicks: yt, xTicks: xt, links: 44 });
  ctx.fillStyle = farbe("--akzent");
  werte.forEach((v, i) => {
    const x0 = X(i) + 2, x1 = X(i + 1) - 2;
    ctx.fillRect(x0, Y(v), Math.max(1, x1 - x0), Y(0) - Y(v));
  });
}

function zeichneStunden(liste, abd) {
  const z = Array(24).fill(0); liste.forEach((e) => z[new Date(e.start * 1000).getHours()]++);
  const rate = z.map((v, h) => (abd.stunden[h] ? v / abd.stunden[h] : 0));
  balken($("#a-stunden"), rate, rate.map((_, h) => String(h)), { fmt: (v) => zahl(v, v < 1 ? 2 : 1) });
}

function zeichneAbstaende(abst) {
  const grenzen = [60, 300, 900, 1800, 3600, 7200, 14400, 28800, 57600, 86400, Infinity];
  const namen = ["<1 min", "1–5 min", "5–15 min", "15–30 min", "30–60 min", "1–2 h", "2–4 h", "4–8 h", "8–16 h", "16–24 h", ">1 Tag"];
  const z = Array(grenzen.length).fill(0);
  abst.forEach((a) => z[grenzen.findIndex((g) => a < g)]++);
  balken($("#a-abstaende"), z, namen);
}

async function zeichneTagespegel(liste) {
  const tag = $("#a-tag").value; if (!tag) return;
  const von = new Date(tag + "T00:00:00").getTime() / 1000, bis = von + 86400;
  const daten = await speicher.pegel(von, bis);
  const { ctx, w, h } = leinwand($("#a-pegel"));
  const k = S.einst.kalibrierung || 0;
  if (!daten.length) {
    ctx.fillStyle = farbe("--leise"); ctx.textAlign = "center";
    ctx.fillText("Für diesen Tag liegen keine Pegeldaten vor.", w / 2, h / 2); return;
  }
  const werte = daten.flatMap((d) => [d.leq + k, d.lmax + k]);
  const y0 = Math.floor((Math.min(...werte) - 5) / 10) * 10, y1 = Math.ceil((Math.max(...werte) + 5) / 10) * 10;
  const xt = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((s) => [von + s * 3600, s + " Uhr"]);
  const { X, Y } = achsen(ctx, w, h, von, bis, y0, y1, { yTicks: dbTicks(y0, y1), xTicks: xt, xGitter: true });
  const linie = (feld, f, b) => {
    ctx.strokeStyle = f; ctx.lineWidth = b; ctx.beginPath();
    let vorher = null;
    for (const d of daten) {
      if (d[feld] == null) { vorher = null; continue; }
      if (vorher == null || d.ts - vorher > 30) ctx.moveTo(X(d.ts), Y(d[feld] + k)); else ctx.lineTo(X(d.ts), Y(d[feld] + k));
      vorher = d.ts;
    }
    ctx.stroke();
  };
  linie("lmax", farbe("--akzent-2"), 1);
  linie("leq", farbe("--akzent"), 1.5);
  linie("grund", farbe("--grund"), 1);
  ctx.strokeStyle = farbe("--schwelle"); ctx.lineWidth = 2;
  for (const e of liste) if (e.start >= von && e.start < bis) {
    ctx.beginPath(); ctx.moveTo(X(e.start), h - 22); ctx.lineTo(X(e.start), h - 34); ctx.stroke();
  }
}

// ------------------------------------------------------------------ Einstellungen & Export
const FELDER = ["schwelle_ueber_grund", "min_pegel", "min_dauer", "vorlauf", "nachlauf", "max_dauer", "kalibrierung"];
async function ladeEinstellungen() {
  FELDER.forEach((f) => ($("#e-" + f).value = S.einst[f]));
  $("#e-mustererkennung").checked = S.einst.mustererkennung;
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persist = await navigator.storage?.persisted?.().catch(() => false);
  $("#e-speicherplatz").textContent = `${S.ereignisse.length} Aufnahmen gespeichert` +
    (est ? ` · belegt ${zahl(est.usage / 1e6, 0)} MB von ca. ${zahl(est.quota / 1e9, 1)} GB verfügbar` : "") +
    (persist ? " · Speicher ist vor automatischem Löschen geschützt" : "");
}
$("#e-speichern").addEventListener("click", async () => {
  const neu = { ...S.einst, mustererkennung: $("#e-mustererkennung").checked };
  FELDER.forEach((f) => (neu[f] = +$("#e-" + f).value));
  S.einst = neu;
  Object.assign(lauscher.e, neu);
  await speicher.einstellungenSpeichern(neu);
  $("#e-ok").textContent = "Gespeichert ✓"; setTimeout(() => ($("#e-ok").textContent = ""), 2500);
});

function herunterladen(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function csvText(liste) {
  const de = (v, s = 1) => (v == null || !isFinite(v) ? "" : v.toFixed(s).replace(".", ","));
  const k = S.einst.kalibrierung || 0;
  const zeilen = [["ID", "Datum", "Uhrzeit", "Dauer (s)", "Spitze (dB)", "Mittel (dB)", "Grundpegel (dB)", "Frequenz (Hz)",
    "Auslöser", "Datei", "Notiz", "Markiert", ...S.referenzen.map((r) => `Ähnlichkeit ${r.name} (%)`)]];
  for (const e of liste.slice().sort((a, b) => a.start - b.start)) {
    const d = new Date(e.start * 1000);
    zeilen.push([e.id, d.toLocaleDateString("de-DE"), d.toLocaleTimeString("de-DE"), de(e.dauer, 2), de(e.spitze_db + k),
      de(e.mittel_db + k), de(e.grund_db != null ? e.grund_db + k : null), de(e.frequenz, 0), e.ausloeser,
      "aufnahmen/" + dateiname(e), e.notiz, e.markiert, ...S.referenzen.map((r) => (e.treffer[r.id] ? de(e.treffer[r.id].score * 100, 0) : ""))]);
  }
  return "﻿" + zeilen.map((z) => z.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
}

$("#e-export-csv").addEventListener("click", async () => {
  await ladeEreignisse();
  herunterladen(new Blob([csvText(S.ereignisse)], { type: "text/csv" }), "laermprotokoll.csv");
});
$("#e-export-zip").addEventListener("click", async () => {
  const knopf = $("#e-export-zip"); knopf.disabled = true; knopf.textContent = "Erstelle ZIP …";
  try {
    await ladeEreignisse();
    const dateien = [{ name: "laermprotokoll.csv", daten: csvText(S.ereignisse) }];
    for (const e of S.ereignisse) {
      const blob = await speicher.audio(e.id);
      if (blob) dateien.push({ name: "aufnahmen/" + dateiname(e), daten: blob });
    }
    const zip = await zipErstellen(dateien);
    herunterladen(zip, `laermprotokoll_${new Date().toLocaleDateString("sv-SE")}.zip`);
  } finally { knopf.disabled = false; knopf.textContent = "Alles exportieren (ZIP mit WAV + CSV)"; }
});
$("#e-alles-loeschen").addEventListener("click", async () => {
  if (!confirm("Wirklich ALLE Aufnahmen, das Protokoll und die Referenzgeräusche löschen? Das kann nicht rückgängig gemacht werden.")) return;
  await lauscher.stop();
  indexedDB.deleteDatabase("laermprotokoll").onsuccess = () => location.reload();
});

// ------------------------------------------------------------------ Start
(async () => {
  const gespeichert = await speicher.einstellungen().catch(() => null);
  if (gespeichert) S.einst = { ...S.einst, ...gespeichert };
  lauscher = new Lauscher(S.einst, neuesEreignis);
  window.lauscher = lauscher; // für Tests in der Konsole
  await lauscher.referenzenNeuLaden();
  await ladeEreignisse();
  zeigeLetzte();
  statusSchleife();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
