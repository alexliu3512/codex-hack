import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const testDir = path.dirname(__filename);
const rootDir = path.resolve(testDir, "..");
const generatedDir = path.join(testDir, "generated");
const manifestPath = path.join(generatedDir, "manifest.json");

loadDotEnv(path.join(rootDir, ".env"));
loadDotEnv(path.join(testDir, ".env"));
fs.mkdirSync(generatedDir, { recursive: true });
ensureManifest();

const app = express();
const port = Number(process.env.CADYBARA_TEST_PORT ?? 5190);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(testDir));
app.use("/generated", express.static(generatedDir));

app.post("/api/generate-stl", async (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  if (!prompt) {
    res.status(400).json({ error: "Prompt is required." });
    return;
  }

  const apiKey = getCadybaraApiKey();
  if (!apiKey) {
    res.status(400).json({
      error: "Missing CADYBARA_API_KEY. Add it to the root .env or test/.env file.",
    });
    return;
  }

  try {
    const result = await generateCadybaraStl({
      apiKey,
      prompt,
      linearDeflection: req.body?.linear_deflection,
      angularDeflection: req.body?.angular_deflection,
    });
    const entry = saveGeneratedModel(prompt, result);
    res.json(entry);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Cadybara generation failed.",
      detail: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.listen(port, () => {
  console.log(`Cadybara STL test viewer listening on http://127.0.0.1:${port}`);
});

async function generateCadybaraStl({ apiKey, prompt, linearDeflection, angularDeflection }) {
  const response = await fetch("https://cadybara.com/api/agent/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      prompt,
      response_mode: "json",
      linear_deflection: clampNumber(linearDeflection, 0.01, 0.5, 0.05),
      angular_deflection: clampNumber(angularDeflection, 0.01, 0.5, 0.1),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cadybara request failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  if (!data.stl_base64) {
    throw new Error("Cadybara response did not include stl_base64.");
  }

  return {
    stlBytes: Buffer.from(data.stl_base64, "base64"),
    generatedCode: data.generated_code ?? "",
    validation: data.validation ?? null,
  };
}

function saveGeneratedModel(prompt, result) {
  const manifest = readManifest();
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(prompt).slice(0, 42) || "model"}`;
  const stlFile = `${id}.stl`;
  const codeFile = `${id}.py`;
  const metadataFile = `${id}.json`;

  fs.writeFileSync(path.join(generatedDir, stlFile), result.stlBytes);
  fs.writeFileSync(path.join(generatedDir, codeFile), result.generatedCode);

  const entry = {
    id,
    prompt,
    stlUrl: `./generated/${stlFile}`,
    codeUrl: `./generated/${codeFile}`,
    metadataUrl: `./generated/${metadataFile}`,
    validation: result.validation,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(generatedDir, metadataFile), JSON.stringify(entry, null, 2));
  manifest.models.unshift(entry);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return entry;
}

function readManifest() {
  ensureManifest();
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function ensureManifest() {
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, JSON.stringify({ models: [] }, null, 2));
  }
}

function getCadybaraApiKey() {
  return process.env.CADYBARA_API_KEY ?? process.env.cadybara_api_key ?? "";
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) {
      process.env[key] = rest.join("=").replace(/^['"]|['"]$/g, "");
    }
  }
}
