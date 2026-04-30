import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fallbackProject } from "./src/fallbackProject.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadDotEnv(path.join(__dirname, ".env"));

const app = express();
const port = Number(process.env.PORT ?? 5173);
const allowedModels = new Set(["gpt-5.4-mini", "gpt-5.5-2026-04-23"]);
const openAiTimeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? 120_000);
const openAiRetryCount = Number(process.env.OPENAI_RETRY_COUNT ?? 1);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

app.post("/api/generate-project", async (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  const requestedModel = String(req.body?.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini").trim();
  if (!prompt) {
    res.status(400).json({ error: "Prompt is required." });
    return;
  }
  if (!allowedModels.has(requestedModel)) {
    res.status(400).json({ error: "Unsupported model.", allowedModels: [...allowedModels] });
    return;
  }

  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    res.json({
      ...fallbackProject,
      statusLabel: "Demo fallback, no OpenAI key",
      prompt,
    });
    return;
  }

  try {
    const project = await generateHardwareManifest(prompt, apiKey, requestedModel);
    res.json({
      ...normalizeProject(project),
      statusLabel: "Generated with OpenAI",
      model: requestedModel,
      prompt,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Could not generate hardware manifest.",
      detail: error instanceof Error ? error.message : "Unknown error",
      fallback: {
        ...fallbackProject,
        statusLabel: "Fallback after generation error",
        prompt,
      },
    });
  }
});

app.listen(port, () => {
  console.log(`Hardware assembly app listening on http://127.0.0.1:${port}`);
});

async function generateHardwareManifest(prompt, apiKey, model) {
  const requestBody = {
    model,
    instructions:
      "You design early-stage hardware prototypes. Return a practical build manifest for a visual demo. Use proxy geometry primitives, not real CAD. Keep coordinates compact and centered within about -4 to 4 scene units. Use 8 to 14 BOM line items, at most 3 placeholders, at most 5 manufacturers per part, and at most 5 specs to confirm per part. Use assembly/BOM names for the UI, but include catalogNameSuggestions for COTS supplier searches. Avoid fake prices.",
    input: `Hardware project prompt: ${prompt}`,
    max_output_tokens: 8_000,
    text: {
      format: {
        type: "json_schema",
        name: "hardware_project_manifest",
        strict: true,
        schema: hardwareManifestSchema,
      },
    },
  };

  if (model.startsWith("gpt-5")) {
    requestBody.reasoning = { effort: "low" };
  }

  const response = await fetchOpenAiResponses(requestBody, apiKey);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  if (payload.status === "incomplete") {
    const reason = payload.incomplete_details?.reason ?? "unknown";
    throw new Error(`OpenAI response incomplete: ${reason}`);
  }
  const content = extractResponseText(payload);
  if (!content) {
    throw new Error(`OpenAI returned no response text. Response status: ${payload.status ?? "unknown"}.`);
  }

  return JSON.parse(content);
}

async function fetchOpenAiResponses(requestBody, apiKey) {
  const url = `${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/responses`;
  let lastError;

  for (let attempt = 0; attempt <= openAiRetryCount; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), openAiTimeoutMs);
    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (error) {
      lastError = error;
      const message = describeFetchError(error);
      console.error(`OpenAI request attempt ${attempt + 1} failed: ${message}`);
      if (attempt >= openAiRetryCount) {
        throw new Error(`OpenAI request failed before a response was received: ${message}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

function describeFetchError(error) {
  if (!(error instanceof Error)) return "Unknown fetch error";
  if (error.name === "AbortError") return `request timed out after ${Math.round(openAiTimeoutMs / 1000)}s`;
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return `${error.message}${cause}`;
}

function getOpenAiApiKey() {
  return process.env.OPENAI_API_KEY ?? process.env.openai_api_key ?? "";
}

function extractResponseText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;

  return (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((contentItem) => contentItem.type === "output_text" && typeof contentItem.text === "string")
    .map((contentItem) => contentItem.text)
    .join("");
}

function normalizeProject(project) {
  const geometryScale = getGeometryScale(project.parts ?? []);
  const normalizedParts = project.parts.map((part, index) => ({
    ...part,
    id: slugify(part.id || part.name || `part-${index + 1}`),
    qty: Math.max(1, Math.round(Number(part.qty) || 1)),
    catalogNameSuggestions:
      part.type === "cots" && part.catalogNameSuggestions.length === 0
        ? [part.partNo || part.name]
        : part.catalogNameSuggestions,
    geometry: {
      primitives:
        part.geometry.primitives.length > 0
          ? part.geometry.primitives.slice(0, 4).map((primitive) => normalizePrimitive(primitive, geometryScale))
          : [fallbackPrimitive(index, part.type)],
    },
  }));

  return {
    projectName: project.projectName || "Generated Hardware Project",
    summary: project.summary || "Generated assembly manifest.",
    statusLabel: project.statusLabel || "Generated with OpenAI",
    placeholders: project.placeholders.length ? project.placeholders : fallbackProject.placeholders,
    parts: normalizedParts,
  };
}

function getGeometryScale(parts) {
  const values = [];
  for (const part of parts) {
    for (const primitive of part.geometry?.primitives ?? []) {
      values.push(...numericVector(primitive.size), ...numericVector(primitive.position));
    }
  }
  const maxAbs = Math.max(0, ...values.map((value) => Math.abs(value)));
  return maxAbs > 8 ? 4 / maxAbs : 1;
}

function normalizePrimitive(primitive, scale) {
  return {
    ...primitive,
    size: numericVector(primitive.size).map((value) => Math.max(0.04, Math.abs(value * scale))),
    position: numericVector(primitive.position).map((value) => value * scale),
    rotation: numericVector(primitive.rotation),
  };
}

function numericVector(value) {
  const vector = Array.isArray(value) ? value.slice(0, 3) : [];
  while (vector.length < 3) vector.push(0);
  return vector.map((number) => Number(number) || 0);
}

function fallbackPrimitive(index, type) {
  return {
    shape: index % 3 === 0 ? "cylinder" : "box",
    size: [0.45, 0.32, 0.45],
    position: [(index % 5) * 0.55 - 1.1, 0.25 + Math.floor(index / 5) * 0.45, 0],
    rotation: [0, 0, 0],
    colorRole: type,
  };
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
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

const vector3 = {
  type: "array",
  items: { type: "number" },
};

const hardwareManifestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectName", "summary", "statusLabel", "placeholders", "parts"],
  properties: {
    projectName: { type: "string" },
    summary: { type: "string" },
    statusLabel: { type: "string" },
    placeholders: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "status", "detail"],
        properties: {
          title: { type: "string" },
          status: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
    parts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "name",
          "type",
          "qty",
          "material",
          "partNo",
          "description",
          "catalogNameSuggestions",
          "manufacturers",
          "specsToConfirm",
          "geometry",
        ],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          type: { type: "string", enum: ["custom", "cots"] },
          qty: { type: "integer" },
          material: { type: "string" },
          partNo: { type: "string" },
          description: { type: "string" },
          catalogNameSuggestions: {
            type: "array",
            items: { type: "string" },
          },
          manufacturers: {
            type: "array",
            items: { type: "string" },
          },
          specsToConfirm: {
            type: "array",
            items: { type: "string" },
          },
          geometry: {
            type: "object",
            additionalProperties: false,
            required: ["primitives"],
            properties: {
              primitives: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["shape", "size", "position", "rotation", "colorRole"],
                  properties: {
                    shape: { type: "string", enum: ["box", "cylinder", "sphere"] },
                    size: vector3,
                    position: vector3,
                    rotation: vector3,
                    colorRole: { type: "string", enum: ["custom", "cots"] },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
