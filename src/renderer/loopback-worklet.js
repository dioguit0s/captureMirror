// Toca no AudioContext dos clipes os blocos do som do PC que chegam do Rust
// (float 32, estéreo intercalado, mesma taxa do contexto).
// Guarda pouco: o som entra no clipe junto com a imagem, e fila grande viraria
// atraso do som em relação ao vídeo. O que passar do limite é descartado.
const MAX_MS = 100;

class LoopbackFeed extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.offset = 0;
    this.queued = 0;
    this.limit = Math.round((sampleRate * MAX_MS) / 1000);
    this.port.onmessage = ({ data }) => {
      const samples = new Float32Array(data);
      this.chunks.push(samples);
      this.queued += samples.length / 2;
      while (this.queued > this.limit && this.chunks.length > 1) {
        const dropped = this.chunks.shift();
        this.queued -= (dropped.length - this.offset) / 2;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    for (let i = 0; i < left.length; i += 1) {
      const chunk = this.chunks[0];
      if (!chunk) {
        left[i] = 0;
        right[i] = 0;
        continue;
      }
      left[i] = chunk[this.offset];
      right[i] = chunk[this.offset + 1];
      this.offset += 2;
      this.queued -= 1;
      if (this.offset >= chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('loopback-feed', LoopbackFeed);
