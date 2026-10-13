// Runs Kokoro in a background thread so the page never freezes while generating.
const KOKORO_URL = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm";
const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

let tts = null;
let cancelFlag = false;

const tick = () => new Promise(r => setTimeout(r));

async function load() {
  if (tts) { self.postMessage({ type: "ready" }); return; }
  const { KokoroTTS } = await import(KOKORO_URL);
  const files = {};
  tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, {
    dtype: "q8",
    device: "wasm",
    progress_callback: p => {
      if (p.status === "progress" && p.file) {
        files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
        let L = 0, T = 0;
        for (const f of Object.values(files)) { L += f.loaded; T += f.total; }
        if (T) {
          self.postMessage({
            type: "progress",
            percent: (L / T) * 100,
            text: `Downloading voice model: ${(L / 1e6).toFixed(0)} of ${(T / 1e6).toFixed(0)} MB (first time only)`
          });
        }
      }
    }
  });
  self.postMessage({ type: "ready" });
}

// jobs: [{ text, voice, speed }]. Each job is generated in order and sent back as soon as it is ready.
async function generate({ jobs }) {
  cancelFlag = false;
  for (let i = 0; i < jobs.length; i++) {
    if (cancelFlag) { self.postMessage({ type: "cancelled" }); return; }
    const j = jobs[i];
    const out = await tts.generate(j.text, { voice: j.voice, speed: j.speed });
    const audio = out.audio.slice(); // own buffer so it can be transferred
    self.postMessage(
      { type: "chunk", index: i, total: jobs.length, rate: out.sampling_rate || 24000, audio },
      [audio.buffer]
    );
    await tick(); // lets a "cancel" message get through between jobs
  }
  self.postMessage({ type: "done" });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") await load();
    else if (data.type === "generate") await generate(data);
    else if (data.type === "cancel") cancelFlag = true;
  } catch (e) {
    self.postMessage({ type: "error", message: String((e && e.message) || e) });
  }
};
