import * as lib from './lib.js';
import {LOG_VERYSPAM, LOG_SPAM, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_ERROR} from './lib.js';
import {LOG_LEVELS} from './lib.js';

// Work around some issues related to caching and error reporting
//   by forcing this to load up top, before we try to 'addModule' it.
import './audio-worklet-in-to-out.js';

const session_id = Math.floor(Math.random() * 2**32).toString(16);
lib.set_logging_session_id(session_id);
lib.set_logging_context_id("main");

var log_level_select = document.getElementById('logLevel');

LOG_LEVELS.forEach((level) => {
  var el = document.createElement("option");
  el.value = level[0];
  el.text = level[1];
  if (lib.log_level == level[0]) {
    el.selected = true;
  }
  log_level_select.appendChild(el);
});

const SAMPLE_BATCH_SIZE = 150;

lib.log(LOG_INFO, "Starting up");

function close_stream(stream) {
  stream.getTracks().forEach((track) => track.stop());
}

async function force_permission_prompt() {
  // In order to enumerate devices, we must first force a permission prompt by opening a device and then closing it again.
  // See: https://stackoverflow.com/questions/60297972/navigator-mediadevices-enumeratedevices-returns-empty-labels
  var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  close_stream(stream);
}

async function wait_for_mic_permissions() {
  var perm_status = await navigator.permissions.query({name: "microphone"});
  if (perm_status.state == "granted" || perm_status.state == "denied") {
    return;
  } else {
    force_permission_prompt();
    return new Promise((resolve, reject) => {
      perm_status.onchange = (e) => {
        if (e.target.state == "granted" || e.target.state == "denied") {
          resolve();
        }
      }
    });
  }
}

var in_select = document.getElementById('inSelect');
var out_select = document.getElementById('outSelect');

async function enumerate_devices() {
  navigator.mediaDevices.enumerateDevices().then((devices) => {
    // Clear existing entries
    in_select.options.length = 0;
    out_select.options.length = 0;

    devices.forEach((info) => {
      var el = document.createElement("option");
      el.value = info.deviceId;
      if (info.kind === 'audioinput') {
        el.text = info.label || 'Unknown Input';
        in_select.appendChild(el);
      } else if (info.kind === 'audiooutput') {
        el.text = info.label || 'Unknown Output';
        out_select.appendChild(el);
      }
    });

    var el = document.createElement("option");
    el.text = "---";
    el.disabled = true;
    in_select.appendChild(el);

    el = document.createElement("option");
    el.value = "SILENCE";
    el.text = "SILENCE";
    in_select.appendChild(el);

    el = document.createElement("option");
    el.value = "HAMILTON";
    el.text = "HAMILTON";
    in_select.appendChild(el);

    el = document.createElement("option");
    el.value = "CLICKS";
    el.text = "CLICKS";
    in_select.appendChild(el);

    el = document.createElement("option");
    el.value = "ECHO";
    el.text = "ECHO";
    in_select.appendChild(el);

    el = document.createElement("option");
    el.value = "SYNTHETIC";
    el.text = "SYNTHETIC";
    in_select.appendChild(el);

    el = document.createElement("option");
    el.text = "---";
    el.disabled = true;
    out_select.appendChild(el);

    el = document.createElement("option");
    el.value = "NOWHERE";
    el.text = "NOWHERE";
    out_select.appendChild(el);

    el = document.createElement("option");
    el.value = "SYNTHETIC";
    el.text = "SYNTHETIC (use with synthetic source)";
    out_select.appendChild(el);
  });
}

var audioCtx;

var start_button = document.getElementById('startButton');
var stop_button = document.getElementById('stopButton');
var loopback_mode_select = document.getElementById('loopbackMode');
var server_path_text = document.getElementById('serverPath');
var audio_offset_text = document.getElementById('audioOffset');
var sample_rate_text = document.getElementById('sampleRate');
var peak_in_text = document.getElementById('peakIn');
var peak_out_text = document.getElementById('peakOut');
var hamilton_audio_span = document.getElementById('hamiltonAudioSpan');
var output_audio_span = document.getElementById('outputAudioSpan');
var audio_graph_canvas = document.getElementById('audioGraph');
var running = false;

function set_controls(is_running) {
  start_button.disabled = is_running;
  stop_button.disabled = !is_running;
  loopback_mode_select.disabled = is_running;
  in_select.disabled = is_running;
  out_select.disabled = is_running;
  server_path_text.disabled = is_running;
  audio_offset_text.disabled = is_running;
}

async function initialize() {
  await wait_for_mic_permissions();
  await enumerate_devices();
  in_select.disabled = false;
  out_select.disabled = false;
  start_button.disabled = false;

  if (document.location.hostname == "localhost") {
    // Better default
    server_path_text.value = "http://localhost:8081/"
  }
}

function debug_check_sample_rate(rate) {
  if (sample_rate_text.value == "Loading...") {
    lib.log(LOG_DEBUG, "First setting sample rate:", rate);
    sample_rate_text.value = rate;
  } else if (sample_rate_text.value == rate.toString()) {
    lib.log(LOG_DEBUG, "Sample rate is still", rate);
  } else {
    lib.log(LOG_ERROR, "SAMPLE RATE CHANGED from", sample_rate_text.value, "to", rate);
    sample_rate_text.value = "ERROR: SAMPLE RATE CHANGED from " + sample_rate_text.value + " to " + rate + "!!";
    stop();
  }
}

async function get_input_node(audioCtx, deviceId) {
  if (deviceId == "SILENCE") {
    var buffer = audioCtx.createBuffer(1, 128, audioCtx.sampleRate);
    var source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopEnd = source.buffer.duration;
    source.start();
    return source;
  } else if (deviceId == "HAMILTON") {
    override_gain = 0.5;
    var hamilton_audio = hamilton_audio_span.getElementsByTagName('audio')[0];
    // Can't use createMediaElementSource because you can only
    //   ever do that once per element, so we could never restart.
    //   See: https://github.com/webAudio/web-audio-api/issues/1202
    var source = audioCtx.createMediaStreamSource(hamilton_audio.captureStream());
    // NOTE: You MUST NOT call "load" on the element after calling
    //   captureStream, or the capture will break. This is not documented
    //   anywhere, of course.
    hamilton_audio.muted = true;  // Output via stream only
    hamilton_audio.loop = true;
    hamilton_audio.controls = false;
    lib.log(LOG_DEBUG, "Starting playback of hamilton...");
    await hamilton_audio.play();
    lib.log(LOG_DEBUG, "... started");
    return source;
  }

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      deviceId: { exact: deviceId }
    }
  });

  return new MediaStreamAudioSourceNode(audioCtx, { mediaStream: micStream });
}

function get_output_node(audioCtx, deviceId) {
  if (deviceId == "NOWHERE") {
    return audioCtx.createMediaStreamDestination();
  }

  var audio_out = new Audio();
  var dest = audioCtx.createMediaStreamDestination();
  audio_out.srcObject = dest.stream;
  audio_out.setSinkId(deviceId);
  audio_out.play();
  return dest;
}

// NOTE NOTE NOTE:
// * All `clock` variables are measured in samples.
// * All `clock` variables represent the END of an interval, NOT the
//   beginning. It's arbitrary which one to use, but you have to be
//   consistent, and trust me that it's slightly nicer this way.
var server_clock;
var playerNode;
var micStream;
var read_clock;
var mic_buf;
var mic_buf_clock;
var loopback_mode;
var server_path;
var audio_offset;
var xhrs_inflight;
var override_gain = 1.0;

async function start() {
  running = true;
  set_controls(running);
  audio_offset = parseInt(audio_offset_text.value);
  var sample_rate = 11025;

  read_clock = null;
  mic_buf = [];
  mic_buf_clock = null;
  xhrs_inflight = 0;
  override_gain = 1.0;

  audioCtx = new AudioContext({ sampleRate: sample_rate });
  debug_check_sample_rate(audioCtx.sampleRate);

  loopback_mode = loopback_mode_select.value;

  var synthetic_audio_source = null;
  var input_device = in_select.value;
  if (input_device == "SYNTHETIC" ||
      input_device == "CLICKS" ||
      input_device == "ECHO") {
    synthetic_audio_source = input_device;
    input_device = "SILENCE";
  }

  var micNode = await get_input_node(audioCtx, input_device);

  var synthetic_audio_sink = false;
  var output_device = out_select.value;
  if (output_device == "SYNTHETIC") {
    synthetic_audio_sink = true;
    output_device = "NOWHERE";
  }
  var spkrNode = get_output_node(audioCtx, output_device);

  server_path = server_path_text.value;

  await audioCtx.audioWorklet.addModule('audio-worklet-in-to-out.js');
  playerNode = new AudioWorkletNode(audioCtx, 'player');
  // Stop if there is an exception inside the worklet.
  playerNode.addEventListener("processorerror", stop);
  playerNode.port.postMessage({
    type: "log_params",
    session_id: session_id,
    log_level: lib.log_level
  });

  if (loopback_mode == "main") {
    // I got yer server right here!
    server_clock = Math.round(Date.now() * sample_rate / 1000.0);
  } else {
    // Support relative paths
    var target_url = new URL(server_path, document.location);
    var request_time_ms = Date.now();
    var fetch_result = await fetch(target_url, {
      method: "get",  // default
      cache: "no-store",
    });
    // We need one-way latency; dividing by 2 is unprincipled but probably close enough.
    var server_latency_ms = (Date.now() - request_time_ms) / 2.0;
    var metadata = JSON.parse(fetch_result.headers.get("X-Audio-Metadata"));
    server_clock = Math.round(metadata["server_clock"] + server_latency_ms * sample_rate / 1000.0);
    lib.log(LOG_INFO, "Server clock is estimated to be:", server_clock, " (", metadata["server_clock"], "+", server_latency_ms * sample_rate / 1000.0);
  }
  read_clock = server_clock - audio_offset;

  var audio_params = {
    type: "audio_params",
    sample_rate: sample_rate,
    // We don't know the input latency, but we can guess.
    local_latency: 2 * audioCtx.output_latency,
    synthetic_source: synthetic_audio_source,
    synthetic_sink: synthetic_audio_sink,
    loopback_mode: loopback_mode
  }
  if (synthetic_source !== null) {
    audio_params.local_latency = 0;
  }
  playerNode.port.postMessage(audio_params);

  playerNode.port.onmessage = handle_message;
  micNode.connect(playerNode);
  playerNode.connect(spkrNode);
}

function samples_to_worklet(samples, clock) {
  var message = {
    type: "samples_in",
    samples: samples,
    clock: clock
  };

  lib.log(LOG_SPAM, "Posting to worklet:", message);
  playerNode.port.postMessage(message);
}

// XXX
var sample_encoding = {
  client: Int8Array,
  server: "b",
  // Translate from/to Float32
  send: (x) => {
    x = x * override_gain * 128;
    x = Math.max(Math.min(x, 127), -128);
    return x;
  },
  recv: (x) => x / 127.0
};

function handle_message(event) {
  var msg = event.data;
  lib.log(LOG_VERYSPAM, "onmessage in main thread received ", msg);

  if (!running) {
    lib.log(LOG_WARNING, "Got message when done running");
    return;
  }

  if (msg.type == "exception") {
    lib.log(LOG_ERROR, "Exception thrown in audioworklet:", msg.exception);
    stop();
    return;
  } else if (msg.type != "samples_out") {
    lib.log(LOG_ERROR, "Got message of unknown type:", msg);
    stop();
    return;
  }

  var mic_samples = msg.samples;
  mic_buf.push(mic_samples);

  var peak_in = parseFloat(peak_in_text.value);
  if (isNaN(peak_in)) {
    peak_in = 0.0;
  }

  if (mic_buf.length == SAMPLE_BATCH_SIZE) {
    // Resampling here works automatically for now since we're copying sample-by-sample
    var outdata = new sample_encoding["client"](mic_buf.length * mic_samples.length);
    if (msg.clock !== null) {
      for (var i = 0; i < mic_buf.length; i++) {
        for (var j = 0; j < mic_buf[i].length; j++) {
          if (Math.abs(mic_buf[i][j]) > peak_in) {
            peak_in = Math.abs(mic_buf[i][j]);
          }
          outdata[i * mic_buf[0].length + j] = sample_encoding["send"](mic_buf[i][j]);
        }
      }
      peak_in_text.value = peak_in;
    } else {
      // Still warming up
      for (var i = 0; i < mic_buf.length; i++) {
        for (var j = 0; j < mic_buf[i].length; j++) {
          if (mic_buf[i][j] !== 0) {
            lib.log_every(12800, "nonzero_warmup", LOG_ERROR, "Nonzero mic data during warmup, huh?");
            //throw "Nonzero mic data during warmup, huh?"
          }
        }
      }
    }
    mic_buf = [];

    if (loopback_mode == "main") {
      lib.log(LOG_DEBUG, "looping back samples in main thread");
      var result = new Float32Array(outdata.length);
      for (var i = 0; i < outdata.length; i++) {
        result[i] = sample_encoding["recv"](outdata[i]);
      }
      // Clocks are at the _end_ of intervals; the longer we've been
      //   accumulating data, the more we have to read. (Trust me.)
      read_clock += outdata.length;
      samples_to_worklet(result, read_clock);
      return;
    }

    var xhr = new XMLHttpRequest();
    xhr.onreadystatechange = () => {
      if (xhr.readyState == 4 /* done*/) {
        handle_xhr_result(xhr);
      }
    };
    xhr.debug_id = Date.now();

    try {
      var target_url = new URL(server_path, document.location);
      var params = new URLSearchParams();
      if (msg.clock !== null) {
        params.set('write_clock', msg.clock);
      }
      // Response size always equals request size.
      // Clocks are at the _end_ of intervals; the longer we've been
      //   accumulating data, the more we have to read. (Trust me.)
      read_clock += outdata.length;
      params.set('read_clock', read_clock);
      params.set('encoding', sample_encoding["server"]);
      if (loopback_mode == "server") {
        params.set('loopback', true);
        lib.log(LOG_DEBUG, "looping back samples at server");
      }
      target_url.search = params.toString();

      // Arbitrary cap; browser cap is 8(?) after which they queue
      if (xhrs_inflight >= 4) {
        lib.log(LOG_WARNING, "NOT SENDING XHR w/ ID:", xhr.debug_id, " due to limit -- already in flight:", xhrs_inflight);
        // XXX: This is a disaster probably
        // Discard outgoing data.

        // Incoming data should take care of itself -- our outgoing
        //   request clocks are tied to the isochronous audioworklet
        //   process() cycle.
        return
      }
      lib.log(LOG_SPAM, "Sending XHR w/ ID:", xhr.debug_id, "already in flight:", xhrs_inflight++, "; data size:", outdata.length);
      xhr.open("POST", target_url, true);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.responseType = "arraybuffer";
      xhr.send(outdata);
      lib.log(LOG_SPAM, "... XHR sent.");
    } catch(e) {
      lib.log(LOG_ERROR, "Failed to make XHR:", e);
      stop();
      return;
    }
  }
}

var peak_out = parseFloat(peak_out_text.value);
if (isNaN(peak_out)) {
  peak_out = 0.0;
}

// Only called when readystate is 4 (done)
function handle_xhr_result(xhr) {
  if (!running) {
    lib.log(LOG_WARNING, "Got XHR onreadystatechange w/ID:", xhr.debug_id, "for xhr:", xhr, " when done running; still in flight:", --xhrs_inflight);
    return;
  }

  if (xhr.status == 200) {
    var metadata = JSON.parse(xhr.getResponseHeader("X-Audio-Metadata"));
    lib.log(LOG_DEBUG, "metadata:", metadata);
    var result = new sample_encoding["client"](xhr.response);
    var play_samples = new Float32Array(result.length);
    for (var i = 0; i < result.length; i++) {
      play_samples[i] = sample_encoding["recv"](result[i]);
      if (Math.abs(play_samples[i]) > peak_out) {
        peak_out = Math.abs(play_samples[i]);
      }
    }
    peak_out_text.value = peak_out;
    lib.log(LOG_SPAM, "Got XHR response w/ ID:", xhr.debug_id, "result:", result, " -- still in flight:", --xhrs_inflight);
    if (metadata["kill_client"]) {
      lib.log(LOG_ERROR, "Received kill from server");
      stop()
      return;
    }
    samples_to_worklet(play_samples, metadata["client_read_clock"]);
    var queue_summary = metadata["queue_summary"];
    var queue_size = metadata["queue_size"];
    // may not be advised to change this after drawing? XXX
    audio_graph_canvas.style.width = "100%";
    audio_graph_canvas.width = audio_graph_canvas.clientWidth;
    audio_graph_canvas.height = 100;
    var ctx = audio_graph_canvas.getContext('2d');
    var horz_mult = audio_graph_canvas.clientWidth / queue_size;
    ctx.setTransform(horz_mult, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, queue_size, 100);
    ctx.fillStyle = 'rgb(255, 0, 0)';
    if (queue_summary.length % 2 != 0) {
      queue_summary.push(queue_size);
    }
    for (var i = 0; i < queue_summary.length; i += 2) {
      ctx.fillRect(queue_summary[i], 0, queue_summary[i+1] - queue_summary[i], 50);
    }
    ctx.fillStyle = 'rgb(0, 0, 0)';
    ctx.fillRect(Math.round(metadata["server_clock"] / 128) % queue_size, 0, 1 / horz_mult, 100);
    ctx.fillRect(Math.round(metadata["last_request_clock"] / 128) % queue_size, 0, 1 / horz_mult, 100);
    ctx.fillStyle = 'rgb(0, 255, 0)';
    ctx.fillRect(Math.round(metadata["client_read_clock"] / 128) % queue_size, 0, 1 / horz_mult, 100);
    ctx.fillRect(Math.round((metadata["client_read_clock"] - play_samples.length) / 128) % queue_size, 0, 1 / horz_mult, 100);
    ctx.fillStyle = 'rgb(0, 0, 255)';
    ctx.fillRect(Math.round(metadata["client_write_clock"] / 128) % queue_size, 0, 1 / horz_mult, 100);
    ctx.fillRect(Math.round((metadata["client_write_clock"] - play_samples.length) / 128) % queue_size, 0, 1 / horz_mult, 100);
  } else {
    lib.log(LOG_ERROR, "XHR failed w/ ID:", xhr.debug_id, "stopping:", xhr, " -- still in flight:", --xhrs_inflight);
    stop();
    return;
  }
}

async function stop() {
  running = false;

  lib.log(LOG_INFO, "Closing audio context and mic stream...");
  if (audioCtx) {
    await audioCtx.close();
    audioCtx = undefined;
  }
  if (micStream) {
    close_stream(micStream);
    micStream = undefined;
  }
  lib.log(LOG_INFO, "...closed.");

  set_controls(running);
}

start_button.addEventListener("click", start);
stop_button.addEventListener("click", stop);

log_level_select.addEventListener("change", () => {
  lib.set_log_level(parseInt(log_level_select.value));
  if (playerNode) {
    playerNode.port.postMessage({
      type: "log_params",
      log_level: lib.log_level
    });
  }
});

initialize();
