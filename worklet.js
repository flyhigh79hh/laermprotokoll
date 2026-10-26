// Sammelt die 128er-Audioblöcke zu 2048er-Blöcken und schickt sie an die Seite.
class Sammler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.puffer = new Float32Array(2048);
    this.n = 0;
  }
  process(eingaenge) {
    const kanaele = eingaenge[0];
    if (!kanaele || !kanaele.length) return true;
    const len = kanaele[0].length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (const k of kanaele) s += k[i];
      this.puffer[this.n++] = s / kanaele.length;
      if (this.n === this.puffer.length) {
        this.port.postMessage(this.puffer, [this.puffer.buffer]);
        this.puffer = new Float32Array(2048);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("sammler", Sammler);
