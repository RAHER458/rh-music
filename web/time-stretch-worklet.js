/**
 * RH AI DJ Engine · granular pitch-lock worklet.
 *
 * The media element's playbackRate changes tempo (and therefore pitch). This
 * processor shifts pitch by 1/rate, restoring the original key. It is a
 * low-latency granular shifter, not a full phase vocoder; the offline TS
 * phase-vocoder is used for quality evaluation and future buffered decks.
 */
class RHTimeStretchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pitchRatio', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' },
      { name: 'bypass', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor(options = {}) {
    super();
    this.size = 32768;
    this.mask = this.size - 1;
    this.grain = 1024;
    this.delay = 2048;
    this.rings = [];
    this.write = 0;
    this.phase = 0;
    this.blocks = 0;
    this.peak = 0;
    this.rms = 0;
    this.underruns = 0;
    const channels = (options.processorOptions && options.processorOptions.channels) || 2;
    for (let c = 0; c < channels; c += 1) this.rings.push(new Float32Array(this.size));
  }

  linear(ring, position) {
    let wrapped = position % this.size;
    if (wrapped < 0) wrapped += this.size;
    const i0 = Math.floor(wrapped) & this.mask;
    const i1 = (i0 + 1) & this.mask;
    const frac = wrapped - Math.floor(wrapped);
    return ring[i0] * (1 - frac) + ring[i1] * frac;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;
    const frames = output[0].length;
    const channels = output.length;
    while (this.rings.length < channels) this.rings.push(new Float32Array(this.size));
    const ratio = parameters.pitchRatio[0];
    const bypass = parameters.bypass[0] >= 0.5 || Math.abs(ratio - 1) < 0.0005;
    const phaseStep = 1 / this.grain;
    let peak = 0;
    let sum = 0;

    for (let frame = 0; frame < frames; frame += 1) {
      const phaseA = this.phase;
      const phaseB = (this.phase + 0.5) % 1;
      const windowA = 0.5 - 0.5 * Math.cos(2 * Math.PI * phaseA);
      const windowB = 0.5 - 0.5 * Math.cos(2 * Math.PI * phaseB);
      const windowSum = Math.max(0.001, windowA + windowB);
      for (let c = 0; c < channels; c += 1) {
        const source = input && input[c] ? input[c][frame] : (input && input[0] ? input[0][frame] : 0);
        const ring = this.rings[c];
        ring[this.write] = source || 0;
        let value;
        if (bypass) {
          value = source || 0;
        } else {
          const offsetA = phaseA * this.grain * (ratio - 1);
          const offsetB = phaseB * this.grain * (ratio - 1);
          const sampleA = this.linear(ring, this.write - this.delay + offsetA);
          const sampleB = this.linear(ring, this.write - this.delay + offsetB);
          value = (sampleA * windowA + sampleB * windowB) / windowSum;
        }
        if (!Number.isFinite(value)) { value = 0; this.underruns += 1; }
        output[c][frame] = value;
        peak = Math.max(peak, Math.abs(value));
        sum += value * value;
      }
      this.write = (this.write + 1) & this.mask;
      this.phase += phaseStep;
      if (this.phase >= 1) this.phase -= 1;
    }
    this.peak = Math.max(this.peak * 0.92, peak);
    this.rms = this.rms * 0.92 + Math.sqrt(sum / Math.max(1, frames * channels)) * 0.08;
    this.blocks += 1;
    if (this.blocks % 80 === 0) {
      this.port.postMessage({ peak: this.peak, rms: this.rms, underruns: this.underruns, ratio });
    }
    return true;
  }
}
registerProcessor('rh-time-stretch', RHTimeStretchProcessor);
