// Runs MMS text-to-speech models (VITS) in a background thread so the page stays responsive.
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm";

let lib = null;
const loaded = new Map();
let cancelFlag = false;

const tick = () => new Promise(r => setTimeout(r));

async function getLib() {
  if (!lib) {
    lib = await import(TRANSFORMERS_URL);
    lib.env.allowLocalModels = true;   // ids without a "/" are looked up in ./models/ on this site first
    lib.env.allowRemoteModels = true;  // ids like "Xenova/mms-tts-spa" download from Hugging Face once
    lib.env.localModelPath = new URL("./models/", self.location.href).href;
  }
  return lib;
}

const fileUrl = (id, name) => id.includes("/")
  ? `https://huggingface.co/${id}/resolve/main/${name}`
  : new URL(`./models/${id}/${name}`, self.location.href).href;

// Fallback tokenizer for models that only have vocab.json (no tokenizer.json), such as ones you convert yourself.
// VITS/MMS models read one character at a time, lowercase, skip unknown characters, and put a "blank" id between them.
async function customTokenizer(id) {
  const res = await fetch(fileUrl(id, "vocab.json"));
  if (!res.ok) throw new Error(`vocab.json not found for ${id}`);
  const vocab = await res.json();
  let cfg = {};
  try { const r = await fetch(fileUrl(id, "tokenizer_config.json")); if (r.ok) cfg = await r.json(); } catch {}
  const { Tensor } = await getLib();
  const blank = (cfg.pad_token && Object.hasOwn(vocab, cfg.pad_token)) ? vocab[cfg.pad_token] : 0;
  return text => {
    const t = cfg.normalize === false ? text : text.toLowerCase();
    const ids = [];
    for (const ch of t) if (Object.hasOwn(vocab, ch)) ids.push(vocab[ch]);
    const seq = cfg.add_blank === false ? ids : [blank, ...ids.flatMap(i => [i, blank])];
    return {
      input_ids: new Tensor("int64", BigInt64Array.from(seq, BigInt), [1, seq.length]),
      attention_mask: new Tensor("int64", new BigInt64Array(seq.length).fill(1n), [1, seq.length])
    };
  };
}

async function loadModel(id) {
  if (loaded.has(id)) return loaded.get(id);
  const { AutoTokenizer, VitsModel } = await getLib();
  const files = {};
  const progress_callback = p => {
    if (p.status === "progress" && p.file) {
      files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
      let L = 0, T = 0;
      for (const f of Object.values(files)) { L += f.loaded; T += f.total; }
      if (T) self.postMessage({ type: "progress", percent: (L / T) * 100,
        text: `Downloading voice model: ${(L / 1e6).toFixed(0)} of ${(T / 1e6).toFixed(0)} MB (first time only)` });
    }
  };
  self.postMessage({ type: "progress", percent: 0, text: "Loading voice model..." });

  let tokenize;
  if (id.includes("/")) {
    try { const tok = await AutoTokenizer.from_pretrained(id, { progress_callback }); tokenize = t => tok(t); }
    catch (e) { tokenize = await customTokenizer(id); }
  } else {
    tokenize = await customTokenizer(id);
  }

  let model;
  try { model = await VitsModel.from_pretrained(id, { dtype: "q8", progress_callback }); }
  catch (e) { model = await VitsModel.from_pretrained(id, { dtype: "fp32", progress_callback }); }
  const entry = { tokenize, model, rate: (model.config && model.config.sampling_rate) || 16000 };
  loaded.set(id, entry);
  return entry;
}

// jobs: [{ text, model }]
async function generate({ jobs }) {
  cancelFlag = false;
  for (let i = 0; i < jobs.length; i++) {
    if (cancelFlag) { self.postMessage({ type: "cancelled" }); return; }
    const j = jobs[i];
    let entry;
    try { entry = await loadModel(j.model); }
    catch (e) { self.postMessage({ type: "error", model: j.model, stage: "load", message: String((e && e.message) || e) }); return; }
    const inputs = entry.tokenize(j.text);
    const dims = inputs.input_ids.dims;
    let audio;
    if (dims[dims.length - 1] <= 1) {
      audio = new Float32Array(Math.round(entry.rate * 0.2)); // nothing readable in this text: short silence
    } else {
      const out = await entry.model(inputs);
      audio = Float32Array.from(out.waveform.data);
    }
    self.postMessage({ type: "chunk", index: i, total: jobs.length, rate: entry.rate, audio }, [audio.buffer]);
    await tick();
  }
  self.postMessage({ type: "done" });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "generate") await generate(data);
    else if (data.type === "cancel") cancelFlag = true;
  } catch (e) {
    self.postMessage({ type: "error", stage: "run", message: String((e && e.message) || e) });
  }
};
