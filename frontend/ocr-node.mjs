// Same model, prompt and generation settings as src/features/recognition/worker.ts, on CPU in Node.
import { AutoModelForImageTextToText, AutoProcessor, env, RawImage } from "@huggingface/transformers";
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = "/tmp/claude-1000/-home-walter-Documents-Git-Academia/7a610d18-895f-41f5-b584-aac91d2d4b57/scratchpad/ocr-node/models/";
const repo = "onnx-community/Qwen3.5-0.8B-ONNX-OPT";
const PROMPT = "Transcribe all text on this page verbatim, both printed and handwritten, in reading order. " +
  "Output plain text only, no commentary. Write math in LaTeX. If a word is hard to read, give your best guess.";
const t0 = Date.now();
const processor = await AutoProcessor.from_pretrained(repo);
const model = await AutoModelForImageTextToText.from_pretrained(repo, {
  device: "cpu",
  dtype: { embed_tokens: "q4", vision_encoder: "fp32", decoder_model_merged: "q4" },
});
console.log("loaded in", (Date.now() - t0) / 1000, "s");
for (const file of process.argv.slice(2)) {
  const t = Date.now();
  const src = await RawImage.read(file);
  // Same path as the worker: RGBA pixels -> RawImage(4 channels) -> rgb()
  const rgba = src.rgba();
  const image = new RawImage(rgba.data, rgba.width, rgba.height, 4).rgb();
  const messages = [{ role: "user", content: [{ type: "image" }, { type: "text", text: PROMPT }] }];
  const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await processor(text, image);
  console.log(file.split("/").pop(), "input tokens:", inputs.input_ids.dims.at(-1));
  const out = await model.generate({ ...inputs, max_new_tokens: 512, do_sample: false, repetition_penalty: 1.05 });
  const [decoded] = processor.batch_decode(out.slice(null, [inputs.input_ids.dims.at(-1), null]), { skip_special_tokens: true });
  console.log("---", file.split("/").pop(), (Date.now() - t) / 1000, "s ---\n" + decoded.trim() + "\n");
}
