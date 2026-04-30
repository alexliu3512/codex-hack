import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { fallbackProject, fallbackProjects, getFallbackProject, getFallbackPrompt } from "./fallbackProject.js";

const appShell = document.querySelector("#app-shell");
const viewer = document.querySelector("#assembly-viewer");
const listEl = document.querySelector("#parts-list");
const searchEl = document.querySelector("#part-search");
const customCountEl = document.querySelector("#custom-count");
const cotsCountEl = document.querySelector("#cots-count");
const lineItemCountEl = document.querySelector("#line-item-count");
const totalPartCountEl = document.querySelector("#total-part-count");
const assemblyStatusMetricEl = document.querySelector("#assembly-status-metric");
const sourcingPanel = document.querySelector("#sourcing-panel");
const sourcingTitle = document.querySelector("#sourcing-title");
const sourcingContent = document.querySelector("#sourcing-content");
const closeSourcingButton = document.querySelector("#close-sourcing");
const promptForm = document.querySelector("#project-form");
const promptInput = document.querySelector("#project-prompt");
const generateButton = document.querySelector("#generate-project");
const newProjectButton = document.querySelector("#new-project");
const chatLog = document.querySelector("#chat-log");
const fallbackDemoSelect = document.querySelector("#fallback-demo-select");
const modelSelect = document.querySelector("#model-select");
const generationStatus = document.querySelector("#generation-status");
const projectTitle = document.querySelector("#project-title");
const projectSummary = document.querySelector("#project-summary");
const statusLabel = document.querySelector("#project-status-label");
const displayModeToggle = document.querySelector("#display-mode-toggle");
const displayModeLabel = document.querySelector("#display-mode-label");
const saveProjectButton = document.querySelector("#save-project");
const loadProjectInput = document.querySelector("#load-project");

const supplierSearches = {
  mcmaster: (term) => `https://www.mcmaster.com/catalog/${encodeURIComponent(term)}`,
  misumi: (term) => `https://us.misumi-ec.com/vona2/result/?Keyword=${encodeURIComponent(term)}`,
  digikey: (term) => `https://www.digikey.com/en/products/result?keywords=${encodeURIComponent(term)}`,
  servocity: (term) => `https://www.servocity.com/search/?q=${encodeURIComponent(term)}`,
  pololu: (term) => `https://www.pololu.com/search?query=${encodeURIComponent(term)}`,
  robotshop: (term) => `https://www.robotshop.com/search?q=${encodeURIComponent(term)}`,
  xometry: () => "https://www.xometry.com/quoting/",
  protolabs: () => "https://www.protolabs.com/services/",
  fictiv: () => "https://www.fictiv.com/",
  sendcutsend: () => "https://sendcutsend.com/",
  cadybara: () => "https://cadybara.com",
  rockwest: (term) => `https://www.rockwestcomposites.com/catalogsearch/result/?q=${encodeURIComponent(term)}`,
  dragonplate: (term) => `https://dragonplate.com/catalogsearch/result/?q=${encodeURIComponent(term)}`,
  google: (term) => `https://www.google.com/search?q=${encodeURIComponent(term)}`,
};

let currentProject = fallbackProject;
let parts = [...currentProject.parts];
let selectedPartId = parts[0]?.id ?? "";
let sourcingPanelOpen = false;
let pointCloudMode = false;
let hasUserProject = false;
let chatMessages = [];
let currentFallbackDemoId = fallbackProjects[0]?.id ?? "robot-arm";
const selectedCatalogNames = new Map();
const partGroups = new Map();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf2eee4);
scene.fog = new THREE.Fog(0xf2eee4, 9, 18);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
camera.position.set(5.8, 3.8, 7.6);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewer.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(1.12, 1.45, 0);
controls.minDistance = 3.2;
controls.maxDistance = 16;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

const normalMaterials = {
  custom: new THREE.MeshStandardMaterial({ color: 0x3f6f86, roughness: 0.48, metalness: 0.35 }),
  cots: new THREE.MeshStandardMaterial({ color: 0x7b6550, roughness: 0.58, metalness: 0.22 }),
};

const selectedMaterial = new THREE.MeshStandardMaterial({
  color: 0xd28b43,
  roughness: 0.35,
  metalness: 0.45,
  emissive: 0x402000,
  emissiveIntensity: 0.18,
});

const pickOnlyMaterial = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0,
  depthWrite: false,
});

const pointMaterials = {
  custom: new THREE.PointsMaterial({ color: 0x17242a, size: 0.024, sizeAttenuation: true }),
  cots: new THREE.PointsMaterial({ color: 0x1f1a15, size: 0.024, sizeAttenuation: true }),
};

const selectedPointMaterial = new THREE.PointsMaterial({
  color: 0xb56b2c,
  size: 0.032,
  sizeAttenuation: true,
});

initScene();
renderProject(fallbackProject);
renderChatMessages();
updatePromptMode();
animate();

promptForm.addEventListener("submit", handleProjectChat);
newProjectButton.addEventListener("click", resetProjectChat);
fallbackDemoSelect.addEventListener("change", handleFallbackDemoChange);
searchEl.addEventListener("input", () => renderParts(searchEl.value));
closeSourcingButton.addEventListener("click", closeSourcingPanel);
displayModeToggle.addEventListener("click", togglePointCloudMode);
saveProjectButton.addEventListener("click", saveProject);
loadProjectInput.addEventListener("change", handleProjectFile);
renderer.domElement.addEventListener("pointerdown", handlePointerDown);
window.addEventListener("resize", resize);

function initScene() {
  scene.add(new THREE.HemisphereLight(0xfffbf2, 0x605647, 2.1));

  const keyLight = new THREE.DirectionalLight(0xffffff, 3.5);
  keyLight.position.set(3.8, 6.2, 4.2);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x8ab7c8, 1.05);
  fillLight.position.set(-4, 2, -3);
  scene.add(fillLight);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(4.6, 96),
    new THREE.MeshStandardMaterial({ color: 0xd9d1c1, roughness: 0.92, metalness: 0.05 }),
  );
  floor.name = "static-floor";
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.035;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(9, 24, 0x706758, 0xc2b8a6);
  grid.name = "static-grid";
  grid.position.y = -0.03;
  scene.add(grid);
}

async function handleProjectChat(event) {
  event.preventDefault();
  const message = promptInput.value.trim();
  if (!message) return;

  const isUpdate = hasUserProject && currentProject?.parts?.length;
  const uiSnapshot = isUpdate
    ? {
        selectedPartId,
        selectedCatalogNames: Object.fromEntries(selectedCatalogNames.entries()),
        searchFilter: searchEl.value,
        pointCloudMode,
        keepSourcingOpen: sourcingPanelOpen,
      }
    : {};
  chatMessages.push({ role: "user", content: message });
  renderChatMessages();
  promptInput.value = "";
  setGenerating(true, isUpdate ? "Updating hardware manifest..." : "Generating hardware manifest...");
  try {
    const visualInspection = isUpdate ? await captureVisualInspectionSnapshot() : undefined;
    if (visualInspection) {
      setGenerating(true, "Inspecting rendered assembly, then updating manifest...");
    }

    const response = await fetch(isUpdate ? "/api/update-project" : "/api/generate-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: message,
        model: modelSelect.value,
        fallbackDemo: currentFallbackDemoId,
        project: isUpdate ? currentProject : undefined,
        messages: chatMessages.slice(-10),
        visualInspection,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      if (data.fallback) {
        renderProject(data.fallback, uiSnapshot);
        hasUserProject = true;
        chatMessages.push({
          role: "assistant",
          content: data.assistantMessage ?? "I could not apply that turn, so I kept the last available manifest loaded.",
        });
        renderChatMessages();
        updatePromptMode();
        setGenerating(
          false,
          `${isUpdate ? "Update" : "Generation"} failed: ${data.detail || data.error || "unknown error"}. ${
            isUpdate ? "Project unchanged." : "Showing fallback demo."
          }`,
        );
        return;
      }
      throw new Error(data.detail || data.error || "Generation failed");
    }
    renderProject(data, uiSnapshot);
    hasUserProject = true;
    chatMessages.push({
      role: "assistant",
      content: data.assistantMessage ?? (isUpdate ? "Updated the project manifest." : "Generated the first project manifest."),
    });
    renderChatMessages();
    updatePromptMode();
    setGenerating(false, data.statusLabel ?? "Project generated");
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "unknown error";
    chatMessages.push({ role: "assistant", content: `Could not update the project: ${message}` });
    renderChatMessages();
    updatePromptMode();
    setGenerating(false, `${hasUserProject ? "Update" : "Generation"} failed: ${message}.`);
  }
}

function setGenerating(isGenerating, message) {
  generateButton.disabled = isGenerating;
  promptInput.disabled = isGenerating;
  fallbackDemoSelect.disabled = isGenerating;
  modelSelect.disabled = isGenerating;
  newProjectButton.disabled = isGenerating;
  generationStatus.textContent = message;
}

function renderChatMessages() {
  chatLog.innerHTML = "";
  if (chatMessages.length === 0) {
    chatLog.hidden = true;
    return;
  }

  chatLog.hidden = false;
  chatMessages.slice(-6).forEach((message) => {
    const bubble = document.createElement("div");
    bubble.className = `chat-message chat-message-${message.role}`;
    bubble.innerHTML = `
      <span>${message.role === "user" ? "You" : "Project"}</span>
      <p>${escapeHtml(message.content)}</p>
    `;
    chatLog.appendChild(bubble);
  });
  chatLog.scrollTop = chatLog.scrollHeight;
}

function updatePromptMode() {
  generateButton.textContent = hasUserProject ? "Send" : "Generate";
  promptInput.placeholder = hasUserProject
    ? "Make it lighter, add a camera mount, swap servos for steppers..."
    : getFallbackPrompt(currentFallbackDemoId);
}

function resetProjectChat() {
  loadFallbackDemo(currentFallbackDemoId, {
    status: "Ready for a new project prompt.",
    resetPrompt: true,
  });
}

function handleFallbackDemoChange() {
  loadFallbackDemo(fallbackDemoSelect.value, {
    status: "Fallback demo loaded.",
    resetPrompt: true,
  });
}

function loadFallbackDemo(demoId, options = {}) {
  currentFallbackDemoId = fallbackProjects.find((demo) => demo.id === demoId)?.id ?? fallbackProjects[0].id;
  fallbackDemoSelect.value = currentFallbackDemoId;
  hasUserProject = false;
  chatMessages = [];
  if (options.resetPrompt) promptInput.value = getFallbackPrompt(currentFallbackDemoId);
  renderChatMessages();
  updatePromptMode();
  renderProject(getFallbackProject(currentFallbackDemoId));
  generationStatus.textContent = options.status ?? "Fallback demo loaded.";
}

async function captureVisualInspectionSnapshot() {
  try {
    await waitForNextFrame();
    renderer.render(scene, camera);
    const source = renderer.domElement;
    const maxWidth = 960;
    const scale = Math.min(1, maxWidth / Math.max(1, source.width));
    const captureCanvas = document.createElement("canvas");
    captureCanvas.width = Math.max(1, Math.round(source.width * scale));
    captureCanvas.height = Math.max(1, Math.round(source.height * scale));
    const context = captureCanvas.getContext("2d");
    if (!context) return null;

    context.drawImage(source, 0, 0, captureCanvas.width, captureCanvas.height);
    const selectedPart = parts.find((part) => part.id === selectedPartId);
    return {
      imageUrl: captureCanvas.toDataURL("image/jpeg", 0.82),
      capturedAt: new Date().toISOString(),
      viewport: {
        width: captureCanvas.width,
        height: captureCanvas.height,
        sourceWidth: source.width,
        sourceHeight: source.height,
        devicePixelRatio: window.devicePixelRatio,
      },
      camera: getCameraState(),
      selectedPartId,
      selectedPartName: selectedPart?.name ?? "",
      pointCloudMode,
    };
  } catch (error) {
    console.warn("Visual inspection capture failed", error);
    generationStatus.textContent = "Could not capture a visual inspection; updating from manifest only.";
    return null;
  }
}

function waitForNextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function renderProject(project, options = {}) {
  currentProject = project;
  parts = project.parts ?? [];
  selectedPartId = options.selectedPartId && parts.some((part) => part.id === options.selectedPartId) ? options.selectedPartId : parts[0]?.id ?? "";
  selectedCatalogNames.clear();
  Object.entries(options.selectedCatalogNames ?? {}).forEach(([id, catalogName]) => {
    selectedCatalogNames.set(id, catalogName);
  });
  if (!options.keepSourcingOpen) closeSourcingPanel();
  renderProjectMeta();
  buildAssemblyFromManifest();
  updateCounts();
  renderParts(options.searchFilter ?? "");
  updateAssemblyMaterials();
  if (options.searchFilter !== undefined) searchEl.value = options.searchFilter;
  if (options.pointCloudMode !== undefined) setPointCloudMode(Boolean(options.pointCloudMode));
  if (options.camera) restoreCameraState(options.camera);
  if (options.keepSourcingOpen) {
    const selectedPart = parts.find((part) => part.id === selectedPartId);
    if (selectedPart) renderSourcingPanel(selectedPart);
  }
  resize();
}

function renderProjectMeta() {
  projectTitle.textContent = currentProject.projectName;
  projectSummary.textContent = currentProject.summary;
  statusLabel.textContent = currentProject.statusLabel ?? "Generated manifest";
}

function buildAssemblyFromManifest() {
  partGroups.forEach((group) => {
    scene.remove(group);
    group.traverse((object) => {
      if (object.isMesh || object.isPoints) object.geometry?.dispose();
    });
  });
  partGroups.clear();

  parts.forEach((part) => {
    const group = new THREE.Group();
    group.name = part.id;
    (part.geometry?.primitives ?? []).forEach((primitive, index) => {
      const mesh = makePrimitiveMesh(part, primitive);
      group.add(mesh);
      addPointCloudForMesh(group, mesh, part, index);
    });
    if (group.children.length > 0) {
      partGroups.set(part.id, group);
      scene.add(group);
    }
  });

  frameAssembly();
}

function makePrimitiveMesh(part, primitive) {
  const [a = 0.35, b = 0.35, c = 0.35] = primitive.size ?? [];
  let geometry;
  if (primitive.shape === "cylinder") {
    const [topRadius, bottomRadius, height] = [a, b, c];
    geometry = new THREE.CylinderGeometry(Math.max(0.03, topRadius), Math.max(0.03, bottomRadius), Math.max(0.03, height), 48);
  } else if (primitive.shape === "sphere") {
    const [radius] = [a];
    geometry = new THREE.SphereGeometry(Math.max(0.05, radius), 48, 24);
  } else {
    const [width, height, depth] = [a, b, c];
    geometry = new THREE.BoxGeometry(Math.max(0.04, width), Math.max(0.04, height), Math.max(0.04, depth));
  }

  const mesh = new THREE.Mesh(geometry, normalMaterials[primitive.colorRole ?? part.type] ?? normalMaterials[part.type]);
  mesh.position.set(...safeVector(primitive.position));
  mesh.rotation.set(...safeVector(primitive.rotation));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.partId = part.id;
  mesh.userData.defaultMaterial = mesh.material;
  return mesh;
}

function addPointCloudForMesh(group, mesh, part, index) {
  const pointCount = getPointCountForGeometry(mesh.geometry);
  const pointsGeometry = sampleSurfacePoints(mesh.geometry, pointCount, hashString(`${part.id}-${index}`));
  const points = new THREE.Points(pointsGeometry, pointMaterials[part.type] ?? pointMaterials.custom);
  points.name = `${mesh.name || part.id}-points`;
  points.position.copy(mesh.position);
  points.rotation.copy(mesh.rotation);
  points.scale.copy(mesh.scale);
  points.userData.partId = part.id;
  points.userData.defaultMaterial = points.material;
  points.userData.isPointCloud = true;
  points.visible = pointCloudMode;
  points.frustumCulled = false;
  group.add(points);
}

function getPointCountForGeometry(geometry) {
  geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  const areaEstimate = 2 * (size.x * size.y + size.x * size.z + size.y * size.z);
  return Math.round(THREE.MathUtils.clamp(areaEstimate * 760, 320, 3400));
}

function sampleSurfacePoints(sourceGeometry, count, seed) {
  const geometry = sourceGeometry.index ? sourceGeometry.toNonIndexed() : sourceGeometry;
  const positions = geometry.attributes.position;
  const triangleCount = positions.count / 3;
  const cumulativeAreas = new Float32Array(triangleCount);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  let totalArea = 0;

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    a.fromBufferAttribute(positions, triangle * 3);
    b.fromBufferAttribute(positions, triangle * 3 + 1);
    c.fromBufferAttribute(positions, triangle * 3 + 2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    totalArea += ab.cross(ac).length() * 0.5;
    cumulativeAreas[triangle] = totalArea;
  }

  const random = seededRandom(seed);
  const pointPositions = new Float32Array(count * 3);

  for (let point = 0; point < count; point += 1) {
    const targetArea = random() * totalArea;
    let triangle = 0;
    while (cumulativeAreas[triangle] < targetArea) triangle += 1;

    a.fromBufferAttribute(positions, triangle * 3);
    b.fromBufferAttribute(positions, triangle * 3 + 1);
    c.fromBufferAttribute(positions, triangle * 3 + 2);

    let u = random();
    let v = random();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }

    const sample = a
      .clone()
      .addScaledVector(ab.subVectors(b, a), u)
      .addScaledVector(ac.subVectors(c, a), v);
    pointPositions[point * 3] = sample.x;
    pointPositions[point * 3 + 1] = sample.y;
    pointPositions[point * 3 + 2] = sample.z;
  }

  const pointsGeometry = new THREE.BufferGeometry();
  pointsGeometry.setAttribute("position", new THREE.BufferAttribute(pointPositions, 3));
  return pointsGeometry;
}

function seededRandom(seed) {
  let state = seed || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function safeVector(value) {
  return Array.isArray(value) && value.length === 3 ? value.map((number) => Number(number) || 0) : [0, 0, 0];
}

function frameAssembly() {
  const box = new THREE.Box3();
  partGroups.forEach((group) => box.expandByObject(group));
  if (box.isEmpty()) return;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  controls.target.copy(center);
  const distance = Math.max(5.8, size.length() * 1.45);
  camera.position.set(center.x + distance * 0.64, center.y + distance * 0.42, center.z + distance * 0.84);
  controls.update();
}

function renderParts(filter = "") {
  const normalizedFilter = filter.trim().toLowerCase();
  const visibleParts = parts.filter((part) => {
    const haystack = [
      part.name,
      part.type,
      part.material,
      part.partNo,
      part.description,
      getSelectedCatalogName(part),
      ...(part.catalogNameSuggestions ?? []),
    ].join(" ");
    return haystack.toLowerCase().includes(normalizedFilter);
  });

  listEl.innerHTML = "";
  if (visibleParts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No matching parts";
    listEl.appendChild(empty);
    return;
  }

  visibleParts.forEach((part) => {
    const catalogName = getSelectedCatalogName(part);
    const row = document.createElement("button");
    row.className = `part-row ${part.id === selectedPartId ? "is-selected" : ""}`;
    row.type = "button";
    row.role = "option";
    row.ariaSelected = String(part.id === selectedPartId);
    row.dataset.partId = part.id;
    row.innerHTML = `
      <span class="part-main">
        <span class="part-name">${escapeHtml(part.name)}</span>
        <span class="part-meta">
          <span class="type-${part.type}">${escapeHtml(part.type.toUpperCase())}</span>
          <span>${escapeHtml(part.material || part.partNo || "unspecified")}</span>
        </span>
        <span class="part-description">${escapeHtml(part.description)}</span>
        ${
          part.type === "cots"
            ? `<span class="part-catalog-name">Search as: ${escapeHtml(catalogName)}</span>`
            : ""
        }
      </span>
      <span class="part-qty">x${part.qty}</span>
    `;
    row.addEventListener("click", () => selectPart(part.id, { openSourcing: true }));
    listEl.appendChild(row);
  });
}

function updateCounts() {
  const custom = parts.filter((part) => part.type === "custom").length;
  const totalQty = parts.reduce((sum, part) => sum + Number(part.qty || 0), 0);
  lineItemCountEl.textContent = `${parts.length} line items`;
  totalPartCountEl.textContent = `${totalQty} total parts`;
  assemblyStatusMetricEl.textContent = currentProject.statusMetric ?? "prototype BOM";
  customCountEl.textContent = `${custom} custom`;
  cotsCountEl.textContent = `${parts.length - custom} COTS`;
}

function selectPart(id, options = {}) {
  selectedPartId = id;
  updateAssemblyMaterials();
  renderParts(searchEl.value);
  if (options.openSourcing || sourcingPanelOpen) {
    const part = parts.find((item) => item.id === id);
    if (part) renderSourcingPanel(part);
  }
}

function updateAssemblyMaterials() {
  partGroups.forEach((group, id) => {
    const part = parts.find((item) => item.id === id);
    group.traverse((object) => {
      if (object.isPoints) {
        object.visible = pointCloudMode;
        object.material = id === selectedPartId ? selectedPointMaterial : object.userData.defaultMaterial;
        return;
      }

      if (!object.isMesh) return;
      object.visible = true;
      if (pointCloudMode) {
        object.material = pickOnlyMaterial;
        return;
      }

      object.material = id === selectedPartId ? selectedMaterial : object.userData.defaultMaterial ?? normalMaterials[part?.type ?? "custom"];
    });
  });
}

function togglePointCloudMode() {
  setPointCloudMode(!pointCloudMode);
}

function setPointCloudMode(enabled) {
  pointCloudMode = enabled;
  displayModeToggle.setAttribute("aria-pressed", String(pointCloudMode));
  displayModeToggle.textContent = pointCloudMode ? "Solid CAD" : "Point Cloud";
  displayModeLabel.textContent = pointCloudMode ? "Point Cloud" : "Solid CAD";
  updateAssemblyMaterials();
}

function renderSourcingPanel(part) {
  const plan = getSourcingPlan(part);
  const catalogOptions = getCatalogNameOptions(part);
  sourcingTitle.textContent = part.name;
  sourcingPanel.hidden = false;
  sourcingPanelOpen = true;
  appShell.classList.add("has-sourcing");
  requestAnimationFrame(resize);

  sourcingContent.innerHTML = `
    ${catalogOptions.length ? renderCatalogNamePicker(part, catalogOptions) : ""}
    <div class="sourcing-summary">
      <span class="tag">${escapeHtml(plan.mode)}</span>
      <p>${escapeHtml(plan.lead)}</p>
    </div>
    <div class="sourcing-block">
      <h4>Search Sources</h4>
      <div class="source-list">${plan.sources.map(renderSource).join("")}</div>
    </div>
    <div class="sourcing-block">
      <h4>${part.type === "custom" ? "Potential Hardware Providers" : "Suggested Manufacturers"}</h4>
      <div class="manufacturer-list">${plan.manufacturers.map((name) => `<span>${escapeHtml(name)}</span>`).join("")}</div>
    </div>
    <div class="sourcing-block">
      <h4>Specs To Confirm</h4>
      <div class="spec-list">${plan.specs.map((spec) => `<span>${escapeHtml(spec)}</span>`).join("")}</div>
    </div>
  `;

  sourcingContent.querySelectorAll("[data-catalog-name]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedCatalogNames.set(part.id, button.dataset.catalogName);
      renderParts(searchEl.value);
      renderSourcingPanel(part);
    });
  });
}

function getSourcingPlan(part) {
  if (part.type === "custom") return getCustomSourcingPlan(part);
  return getCotsSourcingPlan(part);
}

function getCustomSourcingPlan(part) {
  const material = String(part.material ?? "").toLowerCase();
  if (material.includes("carbon")) {
    return {
      mode: "Buy stock + finish",
      lead: "Use off-the-shelf carbon fiber stock, then cut, drill, and bond or fasten the generated end interfaces.",
      specs: part.specsToConfirm,
      sources: [
        source("Cadybara", "CAD generation provider", "Generate real CAD geometry before quoting the custom interfaces.", supplierSearches.cadybara()),
        source("Rock West Composites", "Stock tube supplier", "Search carbon fiber tubes and cut-to-length stock.", supplierSearches.rockwest("carbon fiber tube")),
        source("DragonPlate", "Stock tube supplier", "Good for lightweight robotic arm tube stock.", supplierSearches.dragonplate("carbon fiber tube")),
        source("Xometry", "Finishing/secondary ops", "Quote drilling, inserts, or machined bonded interfaces.", supplierSearches.xometry()),
      ],
      manufacturers: withProvider(part.manufacturers, "Cadybara"),
    };
  }

  if (material.includes("nylon") || material.includes("pa12") || material.includes("sls")) {
    return {
      mode: "Quote custom part",
      lead: "Best matched to SLS/MJF nylon printing for compact housings, covers, and internal features.",
      specs: part.specsToConfirm,
      sources: [
        source("Cadybara", "CAD generation provider", "Generate or refine the wrist housing CAD before sending it to print.", supplierSearches.cadybara()),
        source("Xometry", "3D printing quote", "Upload STL/STEP for SLS or MJF nylon pricing.", supplierSearches.xometry()),
        source("Protolabs", "3D printing quote", "Fast quote path for functional nylon prototypes.", supplierSearches.protolabs()),
        source("Fictiv", "Manufacturing quote", "Useful when the part needs DFM review.", supplierSearches.fictiv()),
      ],
      manufacturers: withProvider(part.manufacturers, "Cadybara"),
    };
  }

  return {
    mode: "Quote custom part",
    lead: "Treat this as a custom fabricated part until a real CAD generator decides whether it is best machined, printed, or cut from plate.",
    specs: part.specsToConfirm,
    sources: [
      source("Cadybara", "CAD generation provider", "Generate real part geometry before CNC, print, or plate-cut quoting.", supplierSearches.cadybara()),
      source("Xometry", "Custom quote", "Upload generated STEP/STL and request the closest manufacturing route.", supplierSearches.xometry()),
      source("Protolabs", "Prototype quote", "Fast path for machined or printed prototypes.", supplierSearches.protolabs()),
      source("Fictiv", "Manufacturing quote", "Good option when tolerance review matters.", supplierSearches.fictiv()),
      source("SendCutSend", "Plate/bracket fallback", "Useful if the part can be flattened into a plate profile.", supplierSearches.sendcutsend()),
    ],
    manufacturers: withProvider(part.manufacturers, "Cadybara"),
  };
}

function withProvider(providers, provider) {
  return [...new Set([provider, ...(providers ?? [])])];
}

function getCotsSourcingPlan(part) {
  const catalogName = getSelectedCatalogName(part);
  const normalized = `${part.id} ${part.name} ${part.partNo} ${catalogName}`.toLowerCase();
  const query = `${catalogName} ${currentProject.projectName}`;

  if (normalized.includes("bearing")) {
    return {
      mode: "Buy off the shelf",
      lead: "Bearings are standard catalog parts; confirm bore, OD, width, seal type, and load rating.",
      specs: part.specsToConfirm,
      sources: [
        source("McMaster-Carr", "Industrial supplier", "Search standard bearings and compare dimensional tables.", supplierSearches.mcmaster(catalogName)),
        source("MISUMI", "Automation supplier", "Good for metric bearing variants and CAD downloads.", supplierSearches.misumi(catalogName)),
        source("Digi-Key", "Electromechanical catalog", "Useful for small bearing and robotics inventory checks.", supplierSearches.digikey(catalogName)),
      ],
      manufacturers: part.manufacturers,
    };
  }

  if (normalized.includes("motor") || normalized.includes("servo") || normalized.includes("actuator") || normalized.includes("gearbox")) {
    return {
      mode: "Buy off the shelf",
      lead: "Select by torque, speed, voltage, backlash, mounting pattern, and control interface.",
      specs: part.specsToConfirm,
      sources: [
        source("ServoCity", "Robotics supplier", "Search servos, gearmotors, brackets, and hub hardware.", supplierSearches.servocity(catalogName)),
        source("Pololu", "Robotics supplier", "Good for motors, drivers, and compact gearmotor options.", supplierSearches.pololu(catalogName)),
        source("RobotShop", "Robotics marketplace", "Broad marketplace for actuators and robot components.", supplierSearches.robotshop(catalogName)),
        source("Digi-Key", "Electronics distributor", "Useful when the actuator needs datasheets and stock checks.", supplierSearches.digikey(catalogName)),
      ],
      manufacturers: part.manufacturers,
    };
  }

  if (normalized.includes("fastener") || normalized.includes("screw") || normalized.includes("bolt")) {
    return {
      mode: "Buy off the shelf",
      lead: "Keep hardware standard so the prototype can be assembled with common tools.",
      specs: part.specsToConfirm,
      sources: [
        source("McMaster-Carr", "Industrial supplier", "Fastest path for mechanical hardware.", supplierSearches.mcmaster(catalogName)),
        source("MISUMI", "Automation supplier", "Good for metric hardware and configurable packs.", supplierSearches.misumi(catalogName)),
        source("General web search", "Backup source", "Find local hardware assortments for the demo.", supplierSearches.google(catalogName)),
      ],
      manufacturers: part.manufacturers,
    };
  }

  return {
    mode: "Buy off the shelf",
    lead: "Search this as a standard catalog component, then lock dimensions against the generated assembly.",
    specs: part.specsToConfirm,
    sources: [
      source("McMaster-Carr", "Industrial supplier", "Good first pass for mechanical catalog parts.", supplierSearches.mcmaster(catalogName)),
      source("RobotShop", "Robotics marketplace", "Useful for robotics-specific alternatives.", supplierSearches.robotshop(catalogName)),
      source("General web search", "Manufacturer discovery", "Use the exact spec string to find vendors.", supplierSearches.google(query)),
    ],
    manufacturers: part.manufacturers,
  };
}

function renderCatalogNamePicker(part, options) {
  const selected = getSelectedCatalogName(part);
  return `
    <div class="sourcing-block catalog-name-block">
      <h4>Supplier Search Name</h4>
      <p>Default suggestion is selected, but supplier catalogs may use a different name.</p>
      <div class="catalog-name-options">
        ${options
          .map(
            (option, index) => `
              <button class="catalog-name-option ${option === selected ? "is-active" : ""}" type="button" data-catalog-name="${escapeHtml(option)}">
                <span>${escapeHtml(option)}</span>
                ${index === 0 ? "<small>default</small>" : ""}
              </button>
            `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderSource(item) {
  return `
    <a class="source-card" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
      <span>
        <strong>${escapeHtml(item.name)}</strong>
        <em>${escapeHtml(item.kind)}</em>
      </span>
      <small>${escapeHtml(item.note)}</small>
    </a>
  `;
}

function closeSourcingPanel() {
  sourcingPanelOpen = false;
  sourcingPanel.hidden = true;
  appShell.classList.remove("has-sourcing");
  resize();
}

function getCatalogNameOptions(part) {
  if (part.type !== "cots") return [];
  const options = part.catalogNameSuggestions?.length ? part.catalogNameSuggestions : [part.partNo || part.name, part.name];
  return [...new Set(options.filter(Boolean))];
}

function getSelectedCatalogName(part) {
  const options = getCatalogNameOptions(part);
  return selectedCatalogNames.get(part.id) ?? options[0] ?? part.partNo ?? part.name;
}

function source(name, kind, note, url) {
  return { name, kind, note, url };
}

function saveProject() {
  const projectFile = {
    schema: "codex-hack.hardware-project",
    version: 1,
    savedAt: new Date().toISOString(),
    project: currentProject,
    sourcing: buildSourcingSnapshot(),
    ui: {
      prompt: promptInput.value,
      fallbackDemoId: currentFallbackDemoId,
      hasUserProject,
      chatMessages,
      searchFilter: searchEl.value,
      selectedPartId,
      sourcingPanelOpen,
      selectedCatalogNames: Object.fromEntries(selectedCatalogNames.entries()),
      pointCloudMode,
      camera: getCameraState(),
    },
  };
  const blob = new Blob([JSON.stringify(projectFile, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(currentProject.projectName || "hardware-project")}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  generationStatus.textContent = "Project saved as JSON.";
}

function buildSourcingSnapshot() {
  return parts.map((part) => ({
    partId: part.id,
    selectedCatalogName: getSelectedCatalogName(part),
    plan: getSourcingPlan(part),
  }));
}

async function handleProjectFile(event) {
  const [file] = event.target.files ?? [];
  if (!file) return;

  try {
    const text = await file.text();
    const savedProject = JSON.parse(text);
    loadSavedProject(savedProject);
    generationStatus.textContent = `Loaded ${file.name}.`;
  } catch (error) {
    console.error(error);
    generationStatus.textContent = "Could not load project JSON.";
  } finally {
    event.target.value = "";
  }
}

function loadSavedProject(savedProject) {
  const project = savedProject.project ?? savedProject;
  if (!project?.parts?.length) throw new Error("Saved project does not include parts.");

  const ui = savedProject.ui ?? {};
  currentFallbackDemoId = fallbackProjects.find((demo) => demo.id === ui.fallbackDemoId)?.id ?? currentFallbackDemoId;
  fallbackDemoSelect.value = currentFallbackDemoId;
  promptInput.value = ui.prompt ?? savedProject.prompt ?? promptInput.value;
  hasUserProject = Boolean(ui.hasUserProject ?? true);
  chatMessages = Array.isArray(ui.chatMessages) ? ui.chatMessages.filter(isChatMessage).slice(-20) : [];
  renderChatMessages();
  updatePromptMode();
  renderProject(project, {
    selectedPartId: ui.selectedPartId,
    selectedCatalogNames: ui.selectedCatalogNames,
    searchFilter: ui.searchFilter ?? "",
    pointCloudMode: ui.pointCloudMode,
    camera: ui.camera,
    keepSourcingOpen: Boolean(ui.sourcingPanelOpen),
  });
}

function isChatMessage(message) {
  return ["user", "assistant"].includes(message?.role) && typeof message?.content === "string";
}

function getCameraState() {
  return {
    position: camera.position.toArray(),
    target: controls.target.toArray(),
    zoom: camera.zoom,
  };
}

function restoreCameraState(state) {
  if (!state) return;
  camera.position.fromArray(safeVector(state.position));
  controls.target.fromArray(safeVector(state.target));
  camera.zoom = Number(state.zoom) || 1;
  camera.updateProjectionMatrix();
  controls.update();
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function handlePointerDown(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const hits = raycaster.intersectObjects([...partGroups.values()], true);
  const hit = hits.find((item) => item.object.userData.partId);
  if (hit) selectPart(hit.object.userData.partId);
}

function resize() {
  const { width, height } = viewer.getBoundingClientRect();
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function animate() {
  const time = performance.now() * 0.001;
  const firstActuator = parts.find((part) => /actuator|motor|servo/i.test(`${part.id} ${part.name}`));
  const actuatorGroup = firstActuator ? partGroups.get(firstActuator.id) : null;
  if (actuatorGroup) actuatorGroup.rotation.y = Math.sin(time * 0.45) * 0.08;

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
