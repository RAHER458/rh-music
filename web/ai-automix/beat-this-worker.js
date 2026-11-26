import { analyzeBeatThis } from './beat-this-onnx.js';

self.onmessage = async (event) => {
  const { id, channels, sampleRate, length, numberOfChannels, duration, trackId } = event.data || {};
  try {
    const data = (channels || []).map((array) => new Float32Array(array));
    const buffer = {
      sampleRate,
      length,
      numberOfChannels: numberOfChannels || data.length,
      duration,
      getChannelData: (channel) => data[channel] || data[0] || new Float32Array(0),
    };
    const result = await analyzeBeatThis(buffer, { trackId });
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error && error.message ? error.message : String(error) });
  }
};
