# Cadybara STL Test Viewer

Standalone test harness for generating STL files with Cadybara and displaying them in a Three.js viewer.

## Setup

Add a Cadybara agent key to the repo root `.env` or to `test/.env`:

```bash
CADYBARA_API_KEY=cady_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Lowercase `cadybara_api_key` is also accepted.

## Run

```bash
CADYBARA_TEST_PORT=5190 node test/server.js
```

Open:

```text
http://127.0.0.1:5190
```

Generated files are saved in `test/generated/`:

- `*.stl` STL mesh returned by Cadybara
- `*.py` generated CadQuery code
- `*.json` validation metadata
- `manifest.json` list consumed by the viewer

## Notes

This uses `POST https://cadybara.com/api/agent/generate` with:

```json
{
  "response_mode": "json",
  "linear_deflection": 0.05,
  "angular_deflection": 0.1
}
```

The UI lets you tune both deflection values per request.
