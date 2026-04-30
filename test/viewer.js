import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

const viewer = document.querySelector("#viewer");
const form = document.querySelector("#generate-form");
const promptInput = document.querySelector("#prompt");
const linearInput = document.querySelector("#linear-deflection");
const angularInput = document.querySelector("#angular-deflection");
const generateButton = document.querySelector("#generate-button");
const statusEl = document.querySelector("#status");
const modelListEl = document.querySelector("#model-list");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111417);
scene.fog = new THREE.Fog(0x111417, 7, 16);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
camera.position.set(2.8, 2.1, 3.2);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
viewer.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.35, 0);

const stlLoader = new STLLoader();
let currentModel = null;
let selectedModelId = "";

const modelMaterial = new THREE.MeshStandardMaterial({
  color: 0x8fb9c7,
  roughness: 0.48,
  metalness: 0.25,
});

initScene();
loadManifest();
resize();
animate();

form.addEventListener("submit", handleGenerate);
window.addEventListener("resize", resize);

function initScene() {
  scene.add(new THREE.HemisphereLight(0xf5fbff, 0x111417, 2.3));

  const keyLight = new THREE.DirectionalLight(0xffffff, 3.8);
  keyLight.position.set(3.5, 5.5, 3.2);
  keyLight.castShadow = true;
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0x62d0aa, 1.2);
  rimLight.position.set(-3, 2, -3);
  scene.add(rimLight);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(2.8, 96),
    new THREE.MeshStandardMaterial({ color: 0x171c21, roughness: 0.9, metalness: 0.05 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(5.6, 24, 0x4a535c, 0x252d34);
  grid.position.y = 0.002;
  scene.add(grid);
}

async function handleGenerate(event) {
  event.preventDefault();
  setGenerating(true, "Calling Cadybara and generating STL...");

  try {
    const response = await fetch("/api/generate-stl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: promptInput.value.trim(),
        linear_deflection: Number(linearInput.value),
        angular_deflection: Number(angularInput.value),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || "Generation failed");

    setGenerating(false, data.validation?.brief_reason || "STL generated.");
    await loadManifest(data.id);
  } catch (error) {
    console.error(error);
    setGenerating(false, error instanceof Error ? error.message : "Generation failed.");
  }
}

async function loadManifest(preferredId = "") {
  const response = await fetch("./generated/manifest.json", { cache: "no-store" });
  const manifest = await response.json();
  renderModelList(manifest.models ?? []);

  const model = manifest.models?.find((item) => item.id === preferredId) ?? manifest.models?.[0];
  if (model) await loadStlModel(model);
  if (!model) statusEl.textContent = "No generated STL files yet. Generate one to display it here.";
}

function renderModelList(models) {
  modelListEl.innerHTML = "";
  if (models.length === 0) {
    const empty = document.createElement("p");
    empty.className = "status";
    empty.textContent = "Generated STL files will appear here.";
    modelListEl.appendChild(empty);
    return;
  }

  models.forEach((model) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `model-row ${model.id === selectedModelId ? "is-selected" : ""}`;
    row.innerHTML = `
      <strong>${escapeHtml(model.prompt)}</strong>
      <span>${escapeHtml(model.createdAt)}</span>
      <small>${escapeHtml(model.validation?.brief_reason ?? "No validation note")}</small>
    `;
    row.addEventListener("click", () => loadStlModel(model));
    modelListEl.appendChild(row);
  });
}

async function loadStlModel(model) {
  selectedModelId = model.id;
  const geometry = await stlLoader.loadAsync(model.stlUrl);
  geometry.computeVertexNormals();
  geometry.center();

  if (currentModel) {
    scene.remove(currentModel);
    currentModel.geometry.dispose();
  }

  currentModel = new THREE.Mesh(geometry, modelMaterial);
  currentModel.castShadow = true;
  currentModel.receiveShadow = true;
  fitModel(currentModel);
  scene.add(currentModel);
  statusEl.textContent = `Loaded ${model.prompt}`;

  const rows = modelListEl.querySelectorAll(".model-row");
  rows.forEach((row) => row.classList.toggle("is-selected", row.textContent.includes(model.createdAt)));
}

function fitModel(mesh) {
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  const size = box.getSize(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z) || 1;
  mesh.scale.setScalar(1.8 / maxDimension);
  mesh.position.y = Math.max(0.04, (size.y * mesh.scale.y) / 2);

  controls.target.set(0, mesh.position.y, 0);
  camera.position.set(2.8, 2.1, 3.2);
  controls.update();
}

function setGenerating(isGenerating, message) {
  generateButton.disabled = isGenerating;
  promptInput.disabled = isGenerating;
  linearInput.disabled = isGenerating;
  angularInput.disabled = isGenerating;
  statusEl.textContent = message;
}

function resize() {
  const { width, height } = viewer.getBoundingClientRect();
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function animate() {
  if (currentModel) currentModel.rotation.y += 0.002;
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}
