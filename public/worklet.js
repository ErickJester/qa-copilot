// Convierte audio float32 (ya a 16 kHz) a PCM int16 y lo envía en bloques de ~32 ms.
class PcmSender extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(512);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) {
        const out = this.buf.slice().buffer;
        this.port.postMessage(out, [out]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-sender', PcmSender);
