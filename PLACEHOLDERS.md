# Placeholder Walkthrough

This app now has the real data path shape: a user prompt becomes a structured hardware
manifest, and the UI renders the assembly, BOM, catalog-name aliases, and sourcing panel
from that manifest.

## 1. OpenAI hardware manifest

**Current state:** real server endpoint, fallback manifest without an OpenAI key.

- Endpoint: `POST /api/generate-project`
- Implementation: `server.js`
- Calls OpenAI's Responses API with `fetch`.
- Reads `OPENAI_API_KEY` from the shell or a local `.env` file.
- Also accepts lowercase `openai_api_key` for local convenience.
- Optional model override: `OPENAI_MODEL`, defaulting to `gpt-5.4-mini`.
- Without a token, the endpoint returns the 6DOF arm fallback manifest from
  `src/fallbackProject.js`.

**To make live:** add `OPENAI_API_KEY=...` to `.env` or the shell and restart
`npm start`.

## 2. 3D model generation

**Current state:** proxy CAD primitives.

The OpenAI response schema asks for simple geometry primitives:

- `box`
- `cylinder`
- `sphere`

Each primitive includes size, position, rotation, and color role. The Three.js viewer
builds the whole assembly from those primitives on the fly.

**To make production CAD:** replace or extend `geometry.primitives` with generated
Cadybara `STEP` or `STL` URLs. Keep the same `part.id` values so selection/highlighting
continues to work.

## 3. BOM generation

**Current state:** real dynamic BOM from the manifest.

The BOM is no longer hard-coded in the UI. Each manifest part drives:

- assembly/BOM display name
- custom vs COTS type
- quantity
- material or part number
- description
- supplier catalog-name suggestions
- manufacturer suggestions
- specs to confirm

## 4. Supplier search

**Current state:** generated search links.

The app creates supplier links from the selected catalog search name. For example,
`J1 base actuator` can search as `NEMA 23 geared stepper motor` or
`servo motor with planetary gearbox`.

**To make live sourcing:** replace generated search URLs with distributor APIs such as
Octopart, Digi-Key, Mouser, or supplier-specific catalog integrations.

## 5. Pricing and availability

**Current state:** intentionally not faked.

The app suggests where to search and which specs to confirm, but does not invent live
pricing or inventory.

**To make live:** add supplier API calls after catalog-name selection and attach price,
stock, lead time, and datasheet URL fields to each COTS part.

## 6. Custom manufacturing

**Current state:** recommended fabrication routes.

Custom parts show likely manufacturers and quote paths such as Xometry, Protolabs,
Fictiv, SendCutSend, Rock West Composites, and local shops depending on material.

**To make live:** submit generated CAD files to quoting APIs or export a quote package
with STEP/STL, material, quantity, and tolerances.
