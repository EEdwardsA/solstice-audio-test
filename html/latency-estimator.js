import * as lib from './lib.js';
import {LOG_VERYSPAM, LOG_SPAM, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_ERROR} from './lib.js';

// This trick allows us to load this file as a regular module, which in turn
//   allows us to flush it from the cache when needed, as a workaround for
//   https://bugs.chromium.org/p/chromium/issues/detail?id=880784 .
if (typeof AudioWorkletProcessor === "undefined") {
  lib.log(LOG_INFO, "Latency estimator module preloading");
  // If we are loaded as a regular module, skip the entire rest of the file
  //   (which will not be valid outside the audio worklet context).
} else {

lib.set_logging_context_id("latencyestimator");
lib.log(LOG_INFO, "Latency estimator module loading");

class Player extends AudioWorkletProcessor {
  constructor() {
    super();

    // clicks
    this.click_index = 0;
    this.frame_size = 128;
    this.click_frame_interval =
      Math.round(sampleRate / this.frame_size / 1); // 60 bpm

    // peak detection
    this.window = [];
    this.last_peak = Date.now();
    this.background_noise = 0;
    this.sample_index = 0;
    this.frames_since_last_beat = 0;

    // tuning params
    this.peak_ratio = 10;
    this.min_peak_interval_ms = 200;
    this.window_size_samples = 20;
    this.click_interval_samples = 3000;

    this.latencies = [];
  }

  process (inputs, outputs, parameters) {
    this.click_index++;
    var is_beat = this.click_index % this.click_frame_interval == 0;
    if (is_beat) {
      this.frames_since_last_beat = 0;
    } else {
      this.frames_since_last_beat++;
    }
    for (var i = 0 ; i < outputs.length; i++) {
      for (var j = 0; j < outputs[i].length; j++) {
        for (var k = 0; k < outputs[i][j].length; k++) {
          outputs[i][j][k] = is_beat ? 0.1 : 0;
        }
      }
    }

    var now = Date.now();
    for (var i = 0 ; i < inputs[0][0].length; i++) {
      this.sample_index++;
      this.background_noise += Math.abs(inputs[0][0][i]);

      this.window.push(inputs[0][0][i]);
      if (this.window.length > this.window_size_samples) {
        this.window.shift();
      }
      this.detect_peak(i, now);
    }
    return true;
  }

  detect_peak(index, now) {
    var abs_sum = 0;
    for (var i = 0; i < this.window.length; i++) {
      abs_sum += Math.abs(this.window[i]);
    }
    if (abs_sum / this.window.length >
        this.background_noise / this.sample_index * this.peak_ratio &&
        now - this.last_peak > this.min_peak_interval_ms) {
      this.last_peak = now;
      var latency_samples = index + 128*this.frames_since_last_beat;
      var latency_ms = 1000.0 * latency_samples / sampleRate;
      if (latency_ms > 500) {
        latency_ms -= 1000;
      }

      this.latencies.push(latency_ms);
      this.latencies.sort();
      lib.log(LOG_DEBUG,
        "latency: " + latency_ms +
          " (median " + this.latencies[Math.trunc(this.latencies.length/2)] + ")");
      this.port.postMessage({
        "type": "latency_estimate",
        "samples": this.latencies.length,
        "latency": this.latencies[Math.trunc(this.latencies.length/2)],
      })

    }
  }
}

registerProcessor('player', Player);

} // end clever workaround wrapper