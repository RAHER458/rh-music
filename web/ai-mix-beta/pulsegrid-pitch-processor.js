class PulsegridPitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "pitchRatio",
        defaultValue: 1,
        minValue: 0.5,
        maxValue: 2,
        automationRate: "k-rate",
      },
    ];
  }

  constructor() {
    super();
    this.bufferSize = 32768;
    this.mask = this.bufferSize - 1;
    this.grainSize = 4096;
    this.baseDelay = 8192;
    this.buffers = [];
    this.writeIndex = 0;
    this.phase = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output?.length) return true;

    const frameCount = output[0].length;
    const channels = output.length;
    while (this.buffers.length < channels) this.buffers.push(new Float32Array(this.bufferSize));

    const ratioValues = parameters.pitchRatio;

    for (let frame = 0; frame < frameCount; frame += 1) {
      const ratio = ratioValues.length > 1 ? ratioValues[frame] : ratioValues[0];
      const phaseA = this.phase;
      const phaseB = (this.phase + 0.5) % 1;
      const windowA = 0.5 - 0.5 * Math.cos(2 * Math.PI * phaseA);
      const windowB = 0.5 - 0.5 * Math.cos(2 * Math.PI * phaseB);
      const windowSum = Math.max(0.001, windowA + windowB);

      for (let channel = 0; channel < channels; channel += 1) {
        const ring = this.buffers[channel];
        const source = input[channel] || input[0];
        ring[this.writeIndex] = source?.[frame] || 0;

        const offsetA = phaseA * this.grainSize * (ratio - 1);
        const offsetB = phaseB * this.grainSize * (ratio - 1);
        const readA = this.writeIndex - this.baseDelay + offsetA;
        const readB = this.writeIndex - this.baseDelay + offsetB;
        const sampleA = this.readLinear(ring, readA);
        const sampleB = this.readLinear(ring, readB);
        output[channel][frame] = (sampleA * windowA + sampleB * windowB) / windowSum;
      }

      this.writeIndex = (this.writeIndex + 1) & this.mask;
      this.phase += 1 / this.grainSize;
      if (this.phase >= 1) this.phase -= 1;
    }

    return true;
  }

  readLinear(buffer, position) {
    let wrapped = position % this.bufferSize;
    if (wrapped < 0) wrapped += this.bufferSize;
    const indexA = Math.floor(wrapped) & this.mask;
    const indexB = (indexA + 1) & this.mask;
    const fraction = wrapped - Math.floor(wrapped);
    return buffer[indexA] * (1 - fraction) + buffer[indexB] * fraction;
  }
}

registerProcessor("pulsegrid-pitch-processor", PulsegridPitchProcessor);
