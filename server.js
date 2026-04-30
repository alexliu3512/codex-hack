import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fallbackProject, getFallbackProject } from "./src/fallbackProject.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadDotEnv(path.join(__dirname, ".env"));

const app = express();
const port = Number(process.env.PORT ?? 5173);
const allowedModels = new Set(["gpt-5.4-mini", "gpt-5.5-2026-04-23"]);
const openAiTimeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? 120_000);
const openAiRetryCount = Number(process.env.OPENAI_RETRY_COUNT ?? 1);
const defaultReasoningByModel = {
  "gpt-5.4-mini": "low",
  "gpt-5.5-2026-04-23": "high",
};
const visualInspectionToolName = "inspect_current_3d_model";
const visualInspectionTool = {
  type: "function",
  name: visualInspectionToolName,
  description:
    "Return a current screenshot of the rendered 3D hardware assembly so geometry can be visually inspected before editing the manifest.",
  parameters: {
    type: "object",
    properties: {
      view: {
        type: "string",
        enum: ["current"],
        description: "Inspect the current visible 3D assembly viewport.",
      },
    },
    required: ["view"],
    additionalProperties: false,
  },
  strict: true,
};

app.use(express.json({ limit: "6mb" }));
app.use(express.static(__dirname));

app.post("/api/generate-project", async (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  const requestedModel = String(req.body?.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini").trim();
  const selectedFallbackProject = getFallbackProject(String(req.body?.fallbackDemo ?? ""));
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
      ...selectedFallbackProject,
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
        ...selectedFallbackProject,
        statusLabel: "Fallback after generation error",
        prompt,
      },
    });
  }
});

app.post("/api/update-project", async (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  const requestedModel = String(req.body?.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini").trim();
  const existingProject = req.body?.project;
  const messages = normalizeMessages(req.body?.messages);
  const visualInspection = normalizeVisualInspection(req.body?.visualInspection);
  if (!prompt) {
    res.status(400).json({ error: "Prompt is required." });
    return;
  }
  if (!existingProject?.parts?.length) {
    res.status(400).json({ error: "Current project is required for iterative updates." });
    return;
  }
  if (!allowedModels.has(requestedModel)) {
    res.status(400).json({ error: "Unsupported model.", allowedModels: [...allowedModels] });
    return;
  }

  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    res.json({
      ...normalizeProject({
        ...existingProject,
        statusLabel: "Demo fallback, no OpenAI key",
      }),
      model: requestedModel,
      prompt,
      assistantMessage: "OpenAI is not configured, so I kept the current manifest loaded for this chat turn.",
    });
    return;
  }

  try {
    const project = await generateHardwareManifest(prompt, apiKey, requestedModel, {
      existingProject: normalizeProject(existingProject),
      messages,
      visualInspection,
    });
    res.json({
      ...normalizeProject(project),
      statusLabel: "Updated with OpenAI",
      model: requestedModel,
      prompt,
      assistantMessage: visualInspection
        ? "Inspected the rendered assembly and applied your requested update to the manifest."
        : "Applied your requested update to the manifest.",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Could not update hardware manifest.",
      detail: error instanceof Error ? error.message : "Unknown error",
      fallback: {
        ...normalizeProject(existingProject),
        statusLabel: "Fallback after update error",
        prompt,
      },
      assistantMessage: "I could not apply that update, so the previous manifest is still loaded.",
    });
  }
});

app.listen(port, () => {
  console.log(`Hardware assembly app listening on http://127.0.0.1:${port}`);
});

async function generateHardwareManifest(prompt, apiKey, model, options = {}) {
  const isUpdate = Boolean(options.existingProject);
  const canInspectVisually = isUpdate && Boolean(options.visualInspection);
  const inputItems = buildManifestInput(prompt, options);
  const requestBody = {
    model,
    instructions:
      "You design early-stage hardware prototypes. Return a practical build manifest for a visual demo. Use proxy geometry primitives, not real CAD. Primitive size semantics are strict: box size is [width, height, depth], cylinder size is [topRadius, bottomRadius, height] along the local Y axis, and sphere size is [radius, radius, radius]. Use rotations to orient cylinders, and use several primitives per important custom part when needed to show the actual mechanical intent. Keep coordinates compact and centered within about -4 to 4 scene units. Use 8 to 14 BOM line items, at most 3 placeholders, at most 5 manufacturers per part, and at most 5 specs to confirm per part. Use assembly/BOM names for the UI, but include catalogNameSuggestions for COTS supplier searches. Avoid fake prices." +
      (isUpdate
        ? " This is an iterative edit. Preserve useful existing IDs, sourcing metadata, and geometry unless the user's latest request requires changing them. Return the entire updated manifest, not a patch."
        : ""),
    input: inputItems,
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

  if (canInspectVisually) {
    requestBody.instructions +=
      " Before revising the geometry, call inspect_current_3d_model to see the current rendered assembly screenshot. Use the screenshot to catch missing, hidden, overlapping, tiny, huge, or visually implausible geometry.";
    requestBody.tools = [visualInspectionTool];
    requestBody.tool_choice = { type: "function", name: visualInspectionToolName };
    requestBody.parallel_tool_calls = false;
  }

  const reasoningEffort = getReasoningEffort(model);
  if (reasoningEffort) requestBody.reasoning = { effort: reasoningEffort };

  for (let turn = 0; turn < 3; turn += 1) {
    const response = await fetchOpenAiResponses(requestBody, apiKey);
    const payload = await readOpenAiResponsePayload(response);
    const toolCalls = getFunctionCalls(payload);

    if (toolCalls.length > 0) {
      if (!canInspectVisually) {
        throw new Error(`OpenAI requested a tool, but no visual inspection snapshot is available.`);
      }

      inputItems.push(...(payload.output ?? []));
      toolCalls.forEach((toolCall) => {
        inputItems.push(buildVisualInspectionToolOutput(toolCall, options.visualInspection));
      });
      requestBody.input = inputItems;
      requestBody.tool_choice = "auto";
      requestBody.parallel_tool_calls = false;
      continue;
    }

    const content = extractResponseText(payload);
    if (!content) {
      throw new Error(`OpenAI returned no response text. Response status: ${payload.status ?? "unknown"}.`);
    }

    const project = JSON.parse(content);
    return isUpdate ? project : await validateInitialManifestGeometry(prompt, project, apiKey, model);
  }

  throw new Error("OpenAI did not finish after visual inspection.");
}

async function readOpenAiResponsePayload(response) {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  if (payload.status === "incomplete") {
    const reason = payload.incomplete_details?.reason ?? "unknown";
    throw new Error(`OpenAI response incomplete: ${reason}`);
  }
  return payload;
}

async function validateInitialManifestGeometry(prompt, project, apiKey, model) {
  const requestBody = {
    model,
    instructions:
      "You are reviewing a newly generated hardware manifest before it is rendered. Return the entire manifest, corrected if needed. Check every geometry primitive for scale, orientation, visibility, rough physical contact, and mechanical plausibility. Fix parts that would be hidden, floating unintentionally, far away, paper-thin, huge, overlapping implausibly, or using cylinder/sphere size semantics incorrectly. Keep the same schema and preserve useful sourcing metadata.",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              `Original hardware project prompt: ${prompt}`,
              `Draft manifest to validate: ${JSON.stringify(project)}`,
              "Primitive size semantics: box [width,height,depth], cylinder [topRadius,bottomRadius,height] along local Y, sphere [radius,radius,radius].",
            ].join("\n\n"),
          },
        ],
      },
    ],
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

  const reasoningEffort = getReasoningEffort(model);
  if (reasoningEffort) requestBody.reasoning = { effort: reasoningEffort };

  try {
    const response = await fetchOpenAiResponses(requestBody, apiKey);
    const payload = await readOpenAiResponsePayload(response);
    const content = extractResponseText(payload);
    if (!content) throw new Error(`OpenAI returned no validation text. Response status: ${payload.status ?? "unknown"}.`);
    return JSON.parse(content);
  } catch (error) {
    console.warn("Initial geometry validation failed; using draft manifest.", describeError(error));
    return project;
  }
}

function buildManifestInput(prompt, options) {
  const text = !options.existingProject
    ? `Hardware project prompt: ${prompt}`
    : [
        "Update the existing hardware project manifest from the latest chat turn.",
        `Latest user request: ${prompt}`,
        `Recent chat messages: ${JSON.stringify(options.messages ?? [])}`,
        `Current manifest: ${JSON.stringify(options.existingProject)}`,
      ].join("\n\n");

  return [
    {
      role: "user",
      content: [{ type: "input_text", text }],
    },
  ];
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

function getReasoningEffort(model) {
  const configured = String(process.env.OPENAI_REASONING_EFFORT ?? "").trim().toLowerCase();
  if (["low", "medium", "high"].includes(configured)) return configured;
  return defaultReasoningByModel[model] ?? null;
}

function extractResponseText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;

  return (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((contentItem) => contentItem.type === "output_text" && typeof contentItem.text === "string")
    .map((contentItem) => contentItem.text)
    .join("");
}

function getFunctionCalls(payload) {
  return (payload.output ?? []).filter((item) => item.type === "function_call");
}

function describeError(error) {
  return error instanceof Error ? error.message : "Unknown error";
}

function buildVisualInspectionToolOutput(toolCall, visualInspection) {
  if (toolCall.name !== visualInspectionToolName) {
    return {
      type: "function_call_output",
      call_id: toolCall.call_id,
      output: JSON.stringify({ error: `Unknown tool: ${toolCall.name}` }),
    };
  }

  const metadata = {
    capturedAt: visualInspection.capturedAt,
    viewport: visualInspection.viewport,
    camera: visualInspection.camera,
    selectedPartId: visualInspection.selectedPartId,
    selectedPartName: visualInspection.selectedPartName,
    displayMode: visualInspection.pointCloudMode ? "point cloud" : "solid CAD",
  };

  return {
    type: "function_call_output",
    call_id: toolCall.call_id,
    output: [
      {
        type: "input_text",
        text: `Current 3D assembly screenshot metadata: ${JSON.stringify(metadata)}`,
      },
      {
        type: "input_image",
        image_url: visualInspection.imageUrl,
        detail: "high",
      },
    ],
  };
}

function normalizeVisualInspection(value) {
  if (!value || typeof value !== "object") return null;
  const imageUrl = String(value.imageUrl ?? "").trim();
  const isDataImage = /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(imageUrl);
  if (!isDataImage || imageUrl.length > 5_500_000) return null;

  return {
    imageUrl,
    capturedAt: typeof value.capturedAt === "string" ? value.capturedAt.slice(0, 80) : new Date().toISOString(),
    viewport: normalizePlainObject(value.viewport, 8),
    camera: normalizePlainObject(value.camera, 8),
    selectedPartId: String(value.selectedPartId ?? "").slice(0, 120),
    selectedPartName: String(value.selectedPartName ?? "").slice(0, 160),
    pointCloudMode: Boolean(value.pointCloudMode),
  };
}

function normalizePlainObject(value, maxKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, maxKeys)
      .map(([key, item]) => [String(key).slice(0, 60), normalizeJsonValue(item)]),
  );
}

function normalizeJsonValue(value) {
  if (Array.isArray(value)) return value.slice(0, 8).map(normalizeJsonValue);
  if (value && typeof value === "object") return normalizePlainObject(value, 8);
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value;
  return String(value ?? "").slice(0, 240);
}

function normalizeProject(project) {
  const geometryScale = getGeometryScale(project.parts ?? []);
  const normalizedParts = (project.parts ?? []).map((part, index) => {
    const type = part.type === "cots" ? "cots" : "custom";
    return {
      ...part,
      id: slugify(part.id || part.name || `part-${index + 1}`),
      name: part.name || `Part ${index + 1}`,
      type,
      qty: Math.max(1, Math.round(Number(part.qty) || 1)),
      material: part.material || "unspecified",
      partNo: part.partNo || "",
      description: part.description || "Generated part.",
      catalogNameSuggestions:
        type === "cots" && (part.catalogNameSuggestions ?? []).length === 0
          ? [part.partNo || part.name]
          : part.catalogNameSuggestions ?? [],
      manufacturers: Array.isArray(part.manufacturers) ? part.manufacturers.slice(0, 5) : [],
      specsToConfirm: Array.isArray(part.specsToConfirm) ? part.specsToConfirm.slice(0, 5) : [],
      geometry: {
        primitives:
          (part.geometry?.primitives ?? []).length > 0
            ? part.geometry.primitives.slice(0, 4).map((primitive) => normalizePrimitive(primitive, geometryScale, type))
            : [fallbackPrimitive(index, type)],
      },
    };
  });

  return {
    projectName: project.projectName || "Generated Hardware Project",
    summary: project.summary || "Generated assembly manifest.",
    statusLabel: project.statusLabel || "Generated with OpenAI",
    placeholders: Array.isArray(project.placeholders) && project.placeholders.length ? project.placeholders.slice(0, 3) : fallbackProject.placeholders,
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

function normalizePrimitive(primitive, scale, type = "custom") {
  const shape = ["box", "cylinder", "sphere"].includes(primitive.shape) ? primitive.shape : "box";
  const colorRole = ["custom", "cots"].includes(primitive.colorRole) ? primitive.colorRole : type;
  return {
    ...primitive,
    shape,
    size: normalizePrimitiveSize(shape, primitive.size, scale),
    position: numericVector(primitive.position).map((value) => value * scale),
    rotation: numericVector(primitive.rotation),
    colorRole,
  };
}

function normalizePrimitiveSize(shape, size, scale) {
  const values = numericVector(size).map((value) => Math.abs(value * scale));
  if (shape === "cylinder") {
    const topRadius = Math.max(0.03, values[0] || values[1] || 0);
    const bottomRadius = Math.max(0.03, values[1] || values[0] || 0);
    const height = Math.max(0.04, values[2]);
    return [topRadius, bottomRadius, height];
  }
  if (shape === "sphere") {
    const radius = Math.max(0.05, values[0] || values[1] || values[2] || 0);
    return [radius, radius, radius];
  }
  return values.map((value) => Math.max(0.04, value));
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => ["user", "assistant"].includes(message?.role) && typeof message?.content === "string")
    .slice(-10)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 1_200),
    }));
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
  description: "Exactly three numeric values.",
  minItems: 3,
  maxItems: 3,
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
                    shape: {
                      type: "string",
                      enum: ["box", "cylinder", "sphere"],
                      description: "Primitive renderer shape.",
                    },
                    size: {
                      ...vector3,
                      description:
                        "Shape-specific dimensions: box [width,height,depth]; cylinder [topRadius,bottomRadius,height] along local Y; sphere [radius,radius,radius].",
                    },
                    position: {
                      ...vector3,
                      description: "Center position in scene units.",
                    },
                    rotation: {
                      ...vector3,
                      description: "Euler rotation in radians, ordered [x,y,z]. Use this to aim cylinders.",
                    },
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
