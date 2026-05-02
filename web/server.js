const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const publicRoot = path.join(__dirname, "public");
const firmwareDir = path.join(projectRoot, "firmware");
const modelWeightsPath = path.join(firmwareDir, "model_weights.h");
const fqbn = "arduino:mbed_nano:nano33ble";
const defaultArduinoCli =
  "C:\\Program Files\\Arduino IDE\\resources\\app\\lib\\backend\\resources\\arduino-cli.exe";

let lastBuildStatus = null;
let compileRunning = false;

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

const host = readArg("--host", "127.0.0.1");
const port = Number(readArg("--port", process.env.PORT || "4173"));

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function collectRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function validateModelHeader(modelHeader) {
  if (!modelHeader) {
    return false;
  }
  return (
    modelHeader.includes("#ifndef IMU_RACER_MODEL_WEIGHTS_H_") &&
    modelHeader.includes("constexpr size_t kModelInputSize = 31;") &&
    modelHeader.includes("constexpr size_t kModelOutputSize = 4;") &&
    modelHeader.includes("const float kModelDense2Bias")
  );
}

function arduinoCliPath() {
  if (process.env.ARDUINO_CLI) {
    return process.env.ARDUINO_CLI;
  }
  if (fs.existsSync(defaultArduinoCli)) {
    return defaultArduinoCli;
  }
  return "arduino-cli";
}

function parseCompileOutput(output) {
  const flashMatch = output.match(
    /Sketch uses\s+(\d+)\s+bytes\s+\((\d+)%\).*?Maximum is\s+(\d+)\s+bytes\./s,
  );
  const ramMatch = output.match(
    /Global variables use\s+(\d+)\s+bytes\s+\((\d+)%\).*?Maximum is\s+(\d+)\s+bytes\./s,
  );

  return {
    flashUsed: flashMatch ? Number(flashMatch[1]) : null,
    flashPercent: flashMatch ? Number(flashMatch[2]) : null,
    flashMax: flashMatch ? Number(flashMatch[3]) : null,
    ramUsed: ramMatch ? Number(ramMatch[1]) : null,
    ramPercent: ramMatch ? Number(ramMatch[2]) : null,
    ramMax: ramMatch ? Number(ramMatch[3]) : null,
  };
}

function compileFirmware({ wroteModelHeader }) {
  return new Promise((resolve) => {
    const startedAt = new Date();
    const cli = arduinoCliPath();
    const child = spawn(
      cli,
      ["compile", "--fqbn", fqbn, firmwareDir],
      {
        cwd: projectRoot,
        windowsHide: true,
      },
    );
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      const finishedAt = new Date();
      resolve({
        ok: false,
        board: "Nano 33 BLE Sense",
        fqbn,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        wroteModelHeader,
        error: error.message,
        output,
      });
    });
    child.on("close", (code) => {
      const finishedAt = new Date();
      const parsed = parseCompileOutput(output);
      resolve({
        ok: code === 0,
        board: "Nano 33 BLE Sense",
        fqbn,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        wroteModelHeader,
        exitCode: code,
        ...parsed,
        output,
      });
    });
  });
}

async function handleCompile(request, response) {
  if (compileRunning) {
    sendJson(response, 409, {
      ok: false,
      error: "Firmware compile is already running.",
    });
    return;
  }

  compileRunning = true;
  try {
    const body = await collectRequestBody(request);
    const payload = body ? JSON.parse(body) : {};
    let wroteModelHeader = false;

    if (payload.modelHeader) {
      if (!validateModelHeader(payload.modelHeader)) {
        sendJson(response, 400, {
          ok: false,
          error: "Invalid model_weights.h content.",
        });
        return;
      }
      fs.writeFileSync(modelWeightsPath, payload.modelHeader, "utf8");
      wroteModelHeader = true;
    }

    lastBuildStatus = await compileFirmware({ wroteModelHeader });
    sendJson(response, lastBuildStatus.ok ? 200 : 500, {
      ok: lastBuildStatus.ok,
      status: lastBuildStatus,
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error.message || "Firmware compile failed.",
    });
  } finally {
    compileRunning = false;
  }
}

function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${host}:${port}`);
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === "/") {
    pathname = "/index.html";
  }

  const filePath = path.normalize(path.join(publicRoot, pathname));
  if (!filePath.startsWith(publicRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": contentTypes[extension] || "application/octet-stream",
      "Content-Length": stats.size,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${host}:${port}`);

  if (request.method === "GET" && requestUrl.pathname === "/api/firmware/status") {
    sendJson(response, 200, {
      ok: true,
      status: lastBuildStatus,
      running: compileRunning,
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/firmware/compile") {
    handleCompile(request, response);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405);
    response.end("Method not allowed");
    return;
  }

  serveStatic(request, response);
});

server.listen(port, host, () => {
  console.log(`IMU Racer local server running at http://${host}:${port}/`);
  console.log(`Firmware compile API enabled for ${fqbn}`);
});
