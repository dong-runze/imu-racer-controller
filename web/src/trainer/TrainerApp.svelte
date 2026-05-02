<script>
  import { onDestroy, onMount } from "svelte";

  import controllerBle from "../ble/controllerBle";
  import {
    FEATURE_VERSION,
    FEATURE_WINDOW_MS,
    TRAINING_LABELS,
    createCalibrationFromDataset,
    createMotionSample,
    extractFeatureWindow,
    labelToKeys,
  } from "../ml/featureExtractor";
  import {
    DEFAULT_COMBO_STEER_MARGIN,
    DEFAULT_COMBO_STEER_THRESHOLD,
    DEFAULT_KEY_OFF_THRESHOLD,
    DEFAULT_KEY_ON_THRESHOLD,
    DEFAULT_MAX_ACTIVE_KEYS,
    OUTPUT_KEY_IDS,
    predictWithMlp,
    trainMlpClassifier,
  } from "../ml/mlpClassifier";

  const datasetStorageKey = "imuRacerMlpDatasetV4";
  const modelStorageKey = "imuRacerMlpModelV4";
  const legacyStorageKeys = [
    "imuRacerMlpDatasetV1",
    "imuRacerMlpModelV1",
    "imuRacerMlpDatasetV2",
    "imuRacerMlpModelV2",
    "imuRacerMlpDatasetV3",
    "imuRacerMlpModelV3",
  ];
  const labelIds = TRAINING_LABELS.map((label) => label.id);
  const labelTitleMap = TRAINING_LABELS.reduce((result, label) => {
    result[label.id] = label.title;
    return result;
  }, {});
  const labelColorMap = TRAINING_LABELS.reduce((result, label) => {
    result[label.id] = label.color;
    return result;
  }, {});
  const maxMotionSamples = 180;
  const captureDurationMs = 1600;
  const captureIntervalMs = 180;
  const samplesPerCapture =
    1 + Math.floor((captureDurationMs - 1) / captureIntervalMs);
  const recommendedPerLabel = 24;
  const recommendedSessionsPerLabel = 8;
  let connection = {
    connected: false,
    deviceName: "",
    version: 0,
    error: "",
  };
  let pose = {
    pitch: 0,
    roll: 0,
    yaw: 0,
    flags: 0,
    state: 0,
  };
  let motion = {
    gravityX: 0,
    gravityY: 0,
    gravityZ: 1,
    gyroX: 0,
    gyroY: 0,
    gyroZ: 0,
  };
  let motionSamples = [];
  let dataset = [];
  let model = null;
  let keyOnThreshold = DEFAULT_KEY_ON_THRESHOLD;
  let keyOffThreshold = DEFAULT_KEY_OFF_THRESHOLD;
  let maxActiveKeys = DEFAULT_MAX_ACTIVE_KEYS;
  let comboSteerThreshold = DEFAULT_COMBO_STEER_THRESHOLD;
  let comboSteerMargin = DEFAULT_COMBO_STEER_MARGIN;
  let capture = {
    active: false,
    label: "",
    collected: 0,
    remainingMs: 0,
  };
  let training = {
    active: false,
    error: "",
    progress: null,
  };
  let firmwareBuild = {
    active: false,
    status: null,
    error: "",
  };
  let livePrediction = null;
  let liveFeature = null;
  let firmwareBuildOk = false;
  let firmwareBuildTitle = "Not compiled";
  let firmwareBuildSummary = "Run after training or click firmware compile.";
  let firmwareBuildTimestamp = "No real compile has run in this server session.";
  let selectedSampleIds = [];
  let datasetFilter = "ALL";
  let dataMessage = "";
  let captureTimer = null;
  let poseFrameCount = 0;
  let lastPoseAt = 0;
  let nowMs = 0;
  let lastPoseAgeMs = Number.POSITIVE_INFINITY;
  let captureStatusText = "Not connected";
  let datasetFileInput;
  let modelFileInput;

  function normalizeLabelId(labelId) {
    const normalized = String(labelId || "").trim().toUpperCase();
    const aliases = {
      NONE: "NEUTRAL",
      NULL: "NEUTRAL",
      IDLE: "NEUTRAL",
      FORWARD: "W",
      LEFT: "A",
      BACK: "S",
      BACKWARD: "S",
      REVERSE: "S",
      RIGHT: "D",
      FORWARD_LEFT: "WA",
      "W+A": "WA",
      "W + A": "WA",
      FORWARD_RIGHT: "WD",
      "W+D": "WD",
      "W + D": "WD",
    };
    return aliases[normalized] || normalized;
  }

  function sanitizeDataset(samples) {
    if (!Array.isArray(samples)) {
      return [];
    }

    return samples
      .map((sample) => ({
        ...sample,
        label: normalizeLabelId(sample.label),
      }))
      .filter(
        (sample) =>
          labelIds.includes(sample.label) &&
          sample.featureVersion === FEATURE_VERSION &&
          Array.isArray(sample.features) &&
          Array.isArray(sample.window) &&
          sample.summary,
      );
  }

  function isCompatibleModel(nextModel) {
    return (
      nextModel?.type === "imu-intent-mlp" &&
      nextModel?.task === "wasd-multilabel" &&
      nextModel?.featureVersion === FEATURE_VERSION &&
      nextModel?.layers?.[2]?.weights?.length === OUTPUT_KEY_IDS.length
    );
  }

  function applyRuntimeControls(runtime = {}) {
    keyOnThreshold = Number(runtime.keyOnThreshold ?? DEFAULT_KEY_ON_THRESHOLD);
    keyOffThreshold = Number(runtime.keyOffThreshold ?? DEFAULT_KEY_OFF_THRESHOLD);
    maxActiveKeys = Number(runtime.maxActiveKeys ?? DEFAULT_MAX_ACTIVE_KEYS);
    comboSteerThreshold = Number(
      runtime.comboSteerThreshold ?? DEFAULT_COMBO_STEER_THRESHOLD,
    );
    comboSteerMargin = Number(
      runtime.comboSteerMargin ?? DEFAULT_COMBO_STEER_MARGIN,
    );
  }

  function loadStoredState() {
    try {
      legacyStorageKeys.forEach((key) => window.localStorage.removeItem(key));
      const storedDataset = window.localStorage.getItem(datasetStorageKey);
      const storedModel = window.localStorage.getItem(modelStorageKey);
      dataset = sanitizeDataset(storedDataset ? JSON.parse(storedDataset) : []);
      const parsedModel = storedModel ? JSON.parse(storedModel) : null;
      if (parsedModel && isCompatibleModel(parsedModel)) {
        applyRuntimeControls(parsedModel.runtime);
      }
      model = parsedModel && isCompatibleModel(parsedModel)
        ? attachRuntimeMetadata(parsedModel, createCalibrationFromDataset(dataset))
        : null;
      if (model) {
        applyRuntimeControls(model.runtime);
        window.localStorage.setItem(modelStorageKey, JSON.stringify(model));
      } else {
        window.localStorage.removeItem(modelStorageKey);
      }
      dataMessage = dataset.length
        ? `Loaded ${dataset.length} saved samples.`
        : "Old V1/V2/V3 trainer data was cleared. Start a fresh 4-output sigmoid dataset.";
    } catch (error) {
      dataset = [];
      model = null;
      dataMessage = "Stored trainer data could not be read and was reset.";
    }
  }

  function saveDataset(nextDataset) {
    dataset = sanitizeDataset(nextDataset);
    selectedSampleIds = selectedSampleIds.filter((id) =>
      dataset.some((sample) => sample.id === id),
    );
    window.localStorage.setItem(datasetStorageKey, JSON.stringify(dataset));
  }

  function saveModel(nextModel) {
    model = attachRuntimeMetadata(nextModel);
    if (!model) {
      window.localStorage.removeItem(modelStorageKey);
      return;
    }
    applyRuntimeControls(model.runtime);
    window.localStorage.setItem(modelStorageKey, JSON.stringify(model));
  }

  function persistRuntimeControls() {
    if (!model) {
      return;
    }

    model = attachRuntimeMetadata(model);
    if (model) {
      window.localStorage.setItem(modelStorageKey, JSON.stringify(model));
    }
  }

  function attachRuntimeMetadata(nextModel, calibration = calibrationProfile) {
    if (!nextModel || !isCompatibleModel(nextModel)) {
      return null;
    }

    const runtime = nextModel.runtime || {};
    return {
      ...nextModel,
      featureVersion: FEATURE_VERSION,
      runtime: {
        ...runtime,
        featureVersion: FEATURE_VERSION,
        calibration: runtime.calibration || calibration || null,
        windowMs: runtime.windowMs || FEATURE_WINDOW_MS,
        labels: runtime.labels || TRAINING_LABELS.map((label) => label.id),
        outputKeys: runtime.outputKeys || OUTPUT_KEY_IDS,
        keyOnThreshold: Number(keyOnThreshold),
        keyOffThreshold: Number(keyOffThreshold),
        maxActiveKeys: Number(maxActiveKeys),
        comboSteerThreshold: Number(comboSteerThreshold),
        comboSteerMargin: Number(comboSteerMargin),
      },
    };
  }

  function updateConnection(patch) {
    connection = {
      ...connection,
      ...patch,
    };
  }

  function rememberPose(nextPose) {
    pose = nextPose;
  }

  function rememberMotion(nextMotion) {
    motion = nextMotion;
    poseFrameCount += 1;
    lastPoseAt = performance.now();
    motionSamples = [...motionSamples, createMotionSample(nextMotion)].slice(
      -maxMotionSamples,
    );
  }

  function formatAngle(value) {
    return `${value >= 0 ? "+" : ""}${value.toFixed(1)} deg`;
  }

  function formatGravity(value) {
    if (!Number.isFinite(value)) {
      return "-";
    }
    return value.toFixed(3);
  }

  function formatGravityAngle(value) {
    if (!Number.isFinite(value)) {
      return "-";
    }
    return `${value.toFixed(1)} deg`;
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) {
      return "-";
    }
    return `${Math.round(value * 100)}%`;
  }

  function formatInteger(value) {
    if (!Number.isFinite(value)) {
      return "-";
    }
    return value.toLocaleString("en-US");
  }

  function formatDateTime(value) {
    if (!value) {
      return "-";
    }
    return new Date(value).toLocaleString();
  }

  function isFirmwareBuildSuccessful(status) {
    return Boolean(
      status?.ok === true ||
        (
          Number.isFinite(status?.flashUsed) &&
          Number.isFinite(status?.flashMax) &&
          Number.isFinite(status?.ramUsed) &&
          Number.isFinite(status?.ramMax)
        ),
    );
  }

  function formatLoss(value) {
    if (!Number.isFinite(value)) {
      return "-";
    }
    return value.toFixed(3);
  }

  function countSamples(labelId) {
    return dataset.filter((sample) => sample.label === labelId).length;
  }

  function countCaptureSessions(labelId) {
    return new Set(
      dataset
        .filter((sample) => sample.label === labelId && sample.captureSessionId)
        .map((sample) => sample.captureSessionId),
    ).size;
  }

  function createSample(labelId, captureSessionId) {
    const featureWindow = extractFeatureWindow(motionSamples, calibrationProfile, null, {
      windowMs: FEATURE_WINDOW_MS,
    });

    if (!featureWindow) {
      return null;
    }

    return {
      id: `${labelId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label: labelId,
      featureVersion: FEATURE_VERSION,
      captureSessionId,
      features: featureWindow.features,
      window: featureWindow.window,
      summary: featureWindow.summary,
      createdAt: new Date().toISOString(),
    };
  }

  function captureOne(labelId, captureSessionId) {
    const sample = createSample(labelId, captureSessionId);
    if (!sample) {
      dataMessage = "Capture failed: no live gravity/gyro window is available yet.";
      return false;
    }

    saveDataset([...dataset, sample]);
    capture = {
      ...capture,
      collected: capture.collected + 1,
    };
    dataMessage = `Captured ${labelTitleMap[labelId] || labelId}: ${countSamples(labelId)} samples.`;
    return true;
  }

  function recomputeDatasetFeatures(sourceDataset = dataset) {
    const calibration = createCalibrationFromDataset(sourceDataset);
    return sanitizeDataset(
      sourceDataset.map((sample) => {
        if (!Array.isArray(sample.window) || !sample.window.length) {
          return sample;
        }

        const featureWindow = extractFeatureWindow(
          sample.window.map((motionSample) => ({
            time: 0,
            gravityX: motionSample.gravityX,
            gravityY: motionSample.gravityY,
            gravityZ: motionSample.gravityZ,
            gyroX: motionSample.gyroX,
            gyroY: motionSample.gyroY,
            gyroZ: motionSample.gyroZ,
          })),
          calibration,
          null,
          {
            windowMs: FEATURE_WINDOW_MS,
            useAllSamples: true,
          },
        );

        if (!featureWindow) {
          return sample;
        }

        return {
          ...sample,
          featureVersion: FEATURE_VERSION,
          features: featureWindow.features,
          window: featureWindow.window,
          summary: featureWindow.summary,
        };
      }),
    );
  }

  function finishCapture(message = "") {
    if (captureTimer) {
      window.clearInterval(captureTimer);
      captureTimer = null;
    }
    capture = {
      active: false,
      label: "",
      collected: 0,
      remainingMs: 0,
    };
    if (message) {
      dataMessage = message;
    }
  }

  function resetCaptureLock() {
    finishCapture("Capture lock was reset.");
  }

  function startCapture(labelId) {
    if (capture.active) {
      dataMessage = `Already recording ${capture.label}. Wait for it to finish or reset the capture lock.`;
      return;
    }

    if (!connection.connected) {
      dataMessage = "Connect the controller before collecting samples.";
      return;
    }

    if (motionSamples.length < 4) {
      dataMessage = "Waiting for live motion stream. Upload the V2 firmware, move the board, and try again.";
      return;
    }

    if (lastPoseAgeMs > 1500) {
      dataMessage = "Live motion stream looks stale. Reconnect the controller or move the board.";
      return;
    }

    const startedAt = performance.now();
    const captureSessionId = `${labelId}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    capture = {
      active: true,
      label: labelId,
      collected: 0,
      remainingMs: captureDurationMs,
    };

    captureOne(labelId, captureSessionId);
    captureTimer = window.setInterval(() => {
      const elapsed = performance.now() - startedAt;
      capture = {
        ...capture,
        remainingMs: Math.max(0, captureDurationMs - elapsed),
      };

      if (elapsed >= captureDurationMs) {
        finishCapture(`Finished recording ${labelTitleMap[labelId] || labelId}.`);
        return;
      }

      captureOne(labelId, captureSessionId);
    }, captureIntervalMs);
  }

  async function connect() {
    updateConnection({ error: "" });
    try {
      await controllerBle.connect();
    } catch (error) {
      updateConnection({
        connected: false,
        error: error?.message || "Bluetooth connection failed.",
      });
    }
  }

  async function disconnect() {
    await controllerBle.disconnect();
  }

  async function loadFirmwareStatus() {
    try {
      const response = await fetch("/api/firmware/status", {
        cache: "no-store",
      });
      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      firmwareBuild = {
        active: Boolean(payload.running),
        status: payload.status || null,
        error: "",
      };
    } catch (error) {
      firmwareBuild = {
        active: false,
        status: null,
        error: "Local firmware compile API is not available.",
      };
    }
  }

  async function compileFirmwareWithModel() {
    if (!model) {
      firmwareBuild = {
        active: false,
        status: null,
        error: "Train or import a model before compiling firmware.",
      };
      return null;
    }

    firmwareBuild = {
      ...firmwareBuild,
      active: true,
      error: "",
    };

    try {
      const modelHeader = generateArduinoModelHeader(model);
      const response = await fetch("/api/firmware/compile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ modelHeader }),
      });
      const payload = await response.json();
      firmwareBuild = {
        active: false,
        status: payload.status || null,
        error: payload.ok ? "" : payload.error || "Firmware compile failed.",
      };
      dataMessage = payload.ok
        ? "Firmware compiled with the current exported model."
        : firmwareBuild.error;
      return payload;
    } catch (error) {
      firmwareBuild = {
        active: false,
        status: null,
        error: error?.message || "Firmware compile failed.",
      };
      dataMessage = firmwareBuild.error;
      return null;
    }
  }

  async function trainModel() {
    training = {
      active: true,
      error: "",
      progress: null,
    };

    try {
      const trainingDataset = recomputeDatasetFeatures();
      saveDataset(trainingDataset);
      const trainedModel = await trainMlpClassifier(
        trainingDataset,
        {
          epochs: 140,
          batchSize: 16,
          learningRate: 0.001,
          validationSplit: 0.2,
          patience: 20,
          keyOnThreshold,
          keyOffThreshold,
          maxActiveKeys,
          comboSteerThreshold,
          comboSteerMargin,
        },
        (progress) => {
          training = {
            ...training,
            progress,
          };
        },
      );
      saveModel(trainedModel);
      training = {
        active: false,
        error: "",
        progress: model.training.history[model.training.history.length - 1],
      };
      await compileFirmwareWithModel();
    } catch (error) {
      training = {
        active: false,
        error: error?.message || "Training failed.",
        progress: null,
      };
    }
  }

  function clearDataset() {
    saveDataset([]);
    dataMessage = "All dataset samples were cleared.";
  }

  function clearAllTrainerData() {
    saveDataset([]);
    clearModel();
    dataMessage = "All samples and the trained model were cleared.";
  }

  function clearModel() {
    model = null;
    window.localStorage.removeItem(modelStorageKey);
  }

  function downloadJson(fileName, value) {
    const blob = new Blob([JSON.stringify(value, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  function downloadText(fileName, value) {
    const blob = new Blob([value], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportDataset() {
    downloadJson("imu-racer-training-dataset.json", {
      type: "imu-racer-training-dataset",
      version: 3,
      featureVersion: FEATURE_VERSION,
      labels: TRAINING_LABELS.map((label) => label.id),
      windowMs: FEATURE_WINDOW_MS,
      sampleCount: dataset.length,
      exportedAt: new Date().toISOString(),
      samples: dataset,
    });
  }

  function exportModel() {
    if (!model) {
      return;
    }
    downloadJson("imu-racer-mlp-model.json", attachRuntimeMetadata(model));
  }

  function formatCppFloat(value) {
    const normalized = Number.isFinite(Number(value)) ? Number(value) : 0;
    return `${normalized.toFixed(9)}f`;
  }

  function flattenMatrix(matrix) {
    return matrix.flatMap((row) => row.map((value) => Number(value) || 0));
  }

  function createCppArray(name, values, valuesPerLine = 6) {
    const lines = [];
    for (let index = 0; index < values.length; index += valuesPerLine) {
      lines.push(
        `    ${values
          .slice(index, index + valuesPerLine)
          .map(formatCppFloat)
          .join(", ")}`,
      );
    }

    return `const float ${name}[] = {\n${lines.join(",\n")}\n};`;
  }

  function generateArduinoModelHeader(sourceModel) {
    const runtimeModel = attachRuntimeMetadata(sourceModel);
    const layers = runtimeModel.layers || [];
    if (
      layers.length !== 3 ||
      !layers[0]?.weights?.length ||
      !layers[1]?.weights?.length ||
      !layers[2]?.weights?.length
    ) {
      throw new Error("Model must contain three dense layers.");
    }

    const inputSize = layers[0].weights[0].length;
    const hidden1Size = layers[0].weights.length;
    const hidden2Size = layers[1].weights.length;
    const outputSize = layers[2].weights.length;
    const runtime = runtimeModel.runtime || {};
    const calibration = runtime.calibration || {};
    const defaultVector = { x: 0, y: 0, z: 1 };
    const vectorFor = (key) => calibration?.[key]?.gravity || defaultVector;
    const hasDefaultCalibration = Boolean(
      calibration?.neutral?.gravity &&
        calibration?.forward?.gravity &&
        calibration?.backward?.gravity &&
        calibration?.left?.gravity &&
        calibration?.right?.gravity,
    );
    const neutral = vectorFor("neutral");
    const forward = vectorFor("forward");
    const backward = vectorFor("backward");
    const left = vectorFor("left");
    const right = vectorFor("right");

    if (runtimeModel.featureVersion !== FEATURE_VERSION) {
      throw new Error("Model feature version does not match the Arduino exporter.");
    }

    if (inputSize !== runtimeModel.featureNames?.length) {
      throw new Error("Model input size does not match feature names.");
    }

    if (inputSize !== 31) {
      throw new Error("Feature V2 Arduino firmware expects 31 input features.");
    }

    if (outputSize !== OUTPUT_KEY_IDS.length) {
      throw new Error("Arduino firmware expects four sigmoid outputs: W/A/S/D.");
    }

    return `#ifndef IMU_RACER_MODEL_WEIGHTS_H_
#define IMU_RACER_MODEL_WEIGHTS_H_

#include <Arduino.h>

// Generated by imu-racer-controller trainer.
// Copy this file to firmware/model_weights.h before uploading firmware.

constexpr size_t kModelInputSize = ${inputSize};
constexpr size_t kModelHidden1Size = ${hidden1Size};
constexpr size_t kModelHidden2Size = ${hidden2Size};
constexpr size_t kModelOutputSize = ${outputSize};
constexpr uint8_t kModelFeatureVersion = ${FEATURE_VERSION};
constexpr unsigned long kModelWindowMs = ${Math.round(runtime.windowMs || FEATURE_WINDOW_MS)}UL;
constexpr float kKeyOnThreshold = ${formatCppFloat(runtime.keyOnThreshold ?? keyOnThreshold)};
constexpr float kKeyOffThreshold = ${formatCppFloat(runtime.keyOffThreshold ?? keyOffThreshold)};
constexpr uint8_t kMaxActiveKeys = ${Math.round(runtime.maxActiveKeys || maxActiveKeys)};
constexpr float kComboSteerThreshold = ${formatCppFloat(runtime.comboSteerThreshold ?? comboSteerThreshold)};
constexpr float kComboSteerMargin = ${formatCppFloat(runtime.comboSteerMargin ?? comboSteerMargin)};
constexpr float kModelConfidenceThreshold = kKeyOnThreshold;
constexpr uint8_t kModelHoldFrames = 0;
constexpr bool kModelHasDefaultCalibration = ${hasDefaultCalibration ? "true" : "false"};
constexpr float kModelNeutralGravityX = ${formatCppFloat(neutral.x)};
constexpr float kModelNeutralGravityY = ${formatCppFloat(neutral.y)};
constexpr float kModelNeutralGravityZ = ${formatCppFloat(neutral.z)};
constexpr float kModelForwardGravityX = ${formatCppFloat(forward.x)};
constexpr float kModelForwardGravityY = ${formatCppFloat(forward.y)};
constexpr float kModelForwardGravityZ = ${formatCppFloat(forward.z)};
constexpr float kModelBackwardGravityX = ${formatCppFloat(backward.x)};
constexpr float kModelBackwardGravityY = ${formatCppFloat(backward.y)};
constexpr float kModelBackwardGravityZ = ${formatCppFloat(backward.z)};
constexpr float kModelLeftGravityX = ${formatCppFloat(left.x)};
constexpr float kModelLeftGravityY = ${formatCppFloat(left.y)};
constexpr float kModelLeftGravityZ = ${formatCppFloat(left.z)};
constexpr float kModelRightGravityX = ${formatCppFloat(right.x)};
constexpr float kModelRightGravityY = ${formatCppFloat(right.y)};
constexpr float kModelRightGravityZ = ${formatCppFloat(right.z)};

${createCppArray("kModelFeatureMean", runtimeModel.standardizer.mean)}

${createCppArray("kModelFeatureStd", runtimeModel.standardizer.std)}

${createCppArray("kModelDense0Weights", flattenMatrix(layers[0].weights))}

${createCppArray("kModelDense0Bias", layers[0].bias)}

${createCppArray("kModelDense1Weights", flattenMatrix(layers[1].weights))}

${createCppArray("kModelDense1Bias", layers[1].bias)}

${createCppArray("kModelDense2Weights", flattenMatrix(layers[2].weights))}

${createCppArray("kModelDense2Bias", layers[2].bias)}

#endif  // IMU_RACER_MODEL_WEIGHTS_H_
`;
  }

  function exportArduinoModel() {
    if (!model) {
      return;
    }

    try {
      downloadText("model_weights.h", generateArduinoModelHeader(model));
      dataMessage =
        "Exported Arduino model header. Copy it to firmware/model_weights.h before uploading.";
    } catch (error) {
      training = {
        ...training,
        error: error?.message || "Arduino model export failed.",
      };
    }
  }

  function importJsonFile(event, handler) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        handler(JSON.parse(reader.result));
      } catch (error) {
        training = {
          ...training,
          error: "Imported file is not valid JSON.",
        };
      }
    };
    reader.readAsText(file);
  }

  function importDataset(event) {
    importJsonFile(event, (payload) => {
      const samples = Array.isArray(payload.samples) ? payload.samples : payload;
      if (!Array.isArray(samples)) {
        throw new Error("Dataset JSON must contain a samples array.");
      }
      const cleanSamples = sanitizeDataset(samples);
      saveDataset(cleanSamples);
      dataMessage = `Imported ${cleanSamples.length} valid labeled samples.`;
    });
  }

  function importModel(event) {
    importJsonFile(event, (payload) => {
      if (!isCompatibleModel(payload)) {
        throw new Error("Model JSON must be a Feature V2 W/A/S/D sigmoid MLP.");
      }
      applyRuntimeControls(payload.runtime);
      saveModel(payload);
      dataMessage = "Imported trained Feature V2 W/A/S/D sigmoid model JSON.";
    });
  }

  function keyClass(labelId, key) {
    const keys = labelToKeys(labelId);
    return keys[key];
  }

  function closestAngleLabel(angles = {}) {
    const entries = [
      ["NEUTRAL", angles.neutral],
      ["W", angles.forward],
      ["S", angles.backward],
      ["A", angles.left],
      ["D", angles.right],
    ].filter((entry) => Number.isFinite(entry[1]));

    if (!entries.length) {
      return "-";
    }

    return entries.reduce((best, entry) =>
      entry[1] < best[1] ? entry : best,
    )[0];
  }

  function sampleMatchesFilter(sample) {
    return datasetFilter === "ALL" || sample.label === datasetFilter;
  }

  function isSampleSelected(sampleId) {
    return selectedSampleIds.includes(sampleId);
  }

  function toggleSampleSelection(sampleId) {
    selectedSampleIds = isSampleSelected(sampleId)
      ? selectedSampleIds.filter((id) => id !== sampleId)
      : [...selectedSampleIds, sampleId];
  }

  function selectVisibleSamples() {
    selectedSampleIds = Array.from(
      new Set([
        ...selectedSampleIds,
        ...visibleDataset.map((sample) => sample.id),
      ]),
    );
  }

  function clearSelection() {
    selectedSampleIds = [];
  }

  function deleteSelectedSamples() {
    if (!selectedSampleIds.length) {
      dataMessage = "No samples are selected.";
      return;
    }

    const selectedCount = selectedSampleIds.length;
    saveDataset(
      dataset.filter((sample) => !selectedSampleIds.includes(sample.id)),
    );
    selectedSampleIds = [];
    dataMessage = `Deleted ${selectedCount} selected samples.`;
  }

  function deleteFilteredSamples() {
    if (datasetFilter === "ALL") {
      clearDataset();
      return;
    }

    const beforeCount = dataset.length;
    saveDataset(dataset.filter((sample) => sample.label !== datasetFilter));
    dataMessage = `Deleted ${beforeCount - dataset.length} ${datasetFilter} samples.`;
  }

  $: calibrationProfile = createCalibrationFromDataset(dataset);
  $: datasetStats = TRAINING_LABELS.reduce((stats, label) => {
    stats[label.id] = dataset.filter((sample) => sample.label === label.id).length;
    return stats;
  }, {});
  $: datasetSessionStats = TRAINING_LABELS.reduce((stats, label) => {
    stats[label.id] = countCaptureSessions(label.id);
    return stats;
  }, {});
  $: legacySampleCount = dataset.filter((sample) => !sample.captureSessionId).length;
  $: totalRecommended = recommendedPerLabel * TRAINING_LABELS.length;
  $: dataProgress = Math.min(dataset.length / totalRecommended, 1);
  $: readyToTrain = TRAINING_LABELS.every((label) => datasetStats[label.id] > 0);
  $: lastPoseAgeMs = lastPoseAt ? nowMs - lastPoseAt : Number.POSITIVE_INFINITY;
  $: canCapture =
    connection.connected && motionSamples.length >= 4 && lastPoseAgeMs <= 1500;
  $: captureStatusText = !connection.connected
    ? "Not connected"
    : motionSamples.length < 4
      ? "Waiting for motion frames"
      : lastPoseAgeMs > 1500
        ? "Motion stream stale"
        : capture.active
          ? `Recording ${capture.label}`
          : "Ready to capture";
  $: visibleDataset = dataset
    .filter(sampleMatchesFilter)
    .slice()
    .reverse();
  $: firmwareBuildOk = isFirmwareBuildSuccessful(firmwareBuild.status);
  $: firmwareBuildTitle = firmwareBuild.active
    ? "Compiling..."
    : firmwareBuildOk
      ? `Flash ${firmwareBuild.status.flashPercent}% / RAM ${firmwareBuild.status.ramPercent}%`
      : firmwareBuild.status && !firmwareBuild.status.ok
        ? "Compile failed"
        : "Not compiled";
  $: firmwareBuildSummary = firmwareBuild.active
    ? "arduino-cli is compiling the current firmware."
    : firmwareBuildOk
      ? `${formatInteger(firmwareBuild.status.flashUsed)} / ${formatInteger(firmwareBuild.status.flashMax)} Flash | ${formatInteger(firmwareBuild.status.ramUsed)} / ${formatInteger(firmwareBuild.status.ramMax)} RAM`
      : firmwareBuild.error || firmwareBuild.status?.error || "Run after training or click firmware compile.";
  $: firmwareBuildTimestamp = firmwareBuild.status?.finishedAt
    ? `Last real compile: ${formatDateTime(firmwareBuild.status.finishedAt)}`
    : "No real compile has run in this server session.";
  $: confusionLabels = model?.metrics?.confusionLabels || model?.labels || [];
  $: liveFeature = extractFeatureWindow(motionSamples, calibrationProfile, null, {
    windowMs: FEATURE_WINDOW_MS,
  });
  $: livePrediction =
    model && liveFeature
      ? predictWithMlp(model, liveFeature.features, {
          keyOnThreshold,
          keyOffThreshold,
          maxActiveKeys,
          comboSteerThreshold,
          comboSteerMargin,
        })
      : null;
  $: liveAngles = liveFeature?.summary?.angles || {};
  $: liveScores = liveFeature?.summary?.scores || {};
  $: liveGravity = liveFeature?.summary?.gravity?.mean || {
    x: motion.gravityX,
    y: motion.gravityY,
    z: motion.gravityZ,
  };
  $: liveClosestDirection = closestAngleLabel(liveAngles);

  onMount(() => {
    loadStoredState();
    loadFirmwareStatus();
    nowMs = performance.now();
    const clockTimer = window.setInterval(() => {
      nowMs = performance.now();
    }, 250);
    const firmwareStatusTimer = window.setInterval(() => {
      loadFirmwareStatus();
    }, 2000);

    const handleConnected = (event) => {
      updateConnection({
        connected: true,
        deviceName: event.detail.name,
        version: event.detail.version,
        error: "",
      });
    };
    const handleDisconnected = () => {
      updateConnection({
        connected: false,
        deviceName: "",
      });
    };
    const handlePose = (event) => {
      rememberPose(event.detail);
    };
    const handleMotion = (event) => {
      rememberMotion(event.detail);
    };

    controllerBle.addEventListener("connected", handleConnected);
    controllerBle.addEventListener("disconnected", handleDisconnected);
    controllerBle.addEventListener("pose", handlePose);
    controllerBle.addEventListener("motion", handleMotion);

    if (new URLSearchParams(window.location.search).get("debugPose") === "1") {
      let demoTime = 0;
      const demoTimer = window.setInterval(() => {
        demoTime += 0.08;
        rememberPose({
          pitch: Math.sin(demoTime) * 32,
          roll: Math.cos(demoTime * 0.75) * 28,
          yaw: Math.sin(demoTime * 0.22) * 75,
          flags: 0,
          state: 1,
        });
        rememberMotion({
          gravityX: Math.sin(demoTime) * 0.48,
          gravityY: Math.cos(demoTime * 0.75) * 0.42,
          gravityZ: 0.78,
          gyroX: Math.cos(demoTime) * 18,
          gyroY: Math.sin(demoTime * 0.7) * 14,
          gyroZ: Math.cos(demoTime * 0.4) * 10,
        });
      }, 50);

      return () => {
        window.clearInterval(clockTimer);
        window.clearInterval(firmwareStatusTimer);
        window.clearInterval(demoTimer);
        if (captureTimer) {
          window.clearInterval(captureTimer);
        }
        controllerBle.removeEventListener("connected", handleConnected);
        controllerBle.removeEventListener("disconnected", handleDisconnected);
        controllerBle.removeEventListener("pose", handlePose);
        controllerBle.removeEventListener("motion", handleMotion);
      };
    }

    return () => {
      window.clearInterval(clockTimer);
      window.clearInterval(firmwareStatusTimer);
      if (captureTimer) {
        window.clearInterval(captureTimer);
      }
      controllerBle.removeEventListener("connected", handleConnected);
      controllerBle.removeEventListener("disconnected", handleDisconnected);
      controllerBle.removeEventListener("pose", handlePose);
      controllerBle.removeEventListener("motion", handleMotion);
    };
  });

  onDestroy(() => {
    if (captureTimer) {
      window.clearInterval(captureTimer);
    }
    if (connection.connected) {
      controllerBle.disconnect();
    }
  });
</script>

<main class="trainer-shell">
  <section class="trainer-hero">
    <div>
      <p class="eyebrow">Tiny IMU Trainer</p>
      <h1>Train WASD intent from Nano 33 BLE Sense motion</h1>
      <p class="hero-copy">
        Collect gravity-vector and gyroscope windows, train a small MLP in the
        browser, and export Arduino weights for Nano-side inference.
      </p>
    </div>
    <div class="hero-actions">
      {#if connection.connected}
        <button class="primary" on:click={disconnect}>Disconnect</button>
      {:else}
        <button class="primary" on:click={connect}>Connect Controller</button>
      {/if}
      <a class="secondary" href="/">Open Racer</a>
    </div>
  </section>

  <section class="status-strip">
    <article>
      <span>Device</span>
      <strong>{connection.deviceName || "Not connected"}</strong>
      <em>{connection.connected ? `Firmware ${connection.version || "-"}` : "Chrome Web Bluetooth required"}</em>
    </article>
    <article>
      <span>Live Motion</span>
      <strong>G {motion.gravityX.toFixed(2)} / {motion.gravityY.toFixed(2)} / {motion.gravityZ.toFixed(2)}</strong>
      <em>Gyro {motion.gyroX.toFixed(1)} / {motion.gyroY.toFixed(1)} / {motion.gyroZ.toFixed(1)}</em>
    </article>
    <article>
      <span>Dataset</span>
      <strong>{dataset.length} samples</strong>
      <em>{Math.round(dataProgress * 100)}% of recommended baseline</em>
    </article>
    <article>
      <span>Model</span>
      <strong>{model ? "Ready" : "Not trained"}</strong>
      <em>{model ? `${model.training.sampleCount} samples used` : "MLP 32-16-4 sigmoid"}</em>
    </article>
    <article>
      <span>Firmware Build</span>
      <strong>{firmwareBuildTitle}</strong>
      <em>{firmwareBuildSummary}</em>
    </article>
  </section>

  {#if connection.error || training.error}
    <section class="error-card">
      {connection.error || training.error}
    </section>
  {/if}

  {#if dataMessage}
    <section class="data-message">
      {dataMessage}
    </section>
  {/if}

  <section class="trainer-steps">
    <article class="step-card">
      <span>1</span>
      <strong>Collect</strong>
      <em>Capture each label while holding the board in that intent.</em>
    </article>
    <article class="step-card">
      <span>2</span>
      <strong>Train</strong>
      <em>Browser MLP, Adam optimizer, binary cross-entropy loss.</em>
    </article>
    <article class="step-card">
      <span>3</span>
      <strong>Test</strong>
      <em>Watch live prediction, confidence, and class probabilities.</em>
    </article>
    <article class="step-card">
      <span>4</span>
      <strong>Export</strong>
      <em>Save labeled data and model JSON for future development.</em>
    </article>
  </section>

  <section class="section-head">
    <div>
      <p class="eyebrow">Step 1</p>
      <h2>Collect labeled examples</h2>
    </div>
    <p>
      Recommended: collect at least {recommendedSessionsPerLabel} separate
      captures and {recommendedPerLabel} samples per class.
      Each click records about {samplesPerCapture} labeled windows over
      {captureDurationMs / 1000}s.
    </p>
  </section>

  {#if legacySampleCount}
    <section class="capture-warning">
      {legacySampleCount} legacy samples do not have capture-session IDs. They
      can still train, but validation may look better than real control. For
      the next model, collect fresh samples on this page and retrain.
    </section>
  {/if}

  <section class="capture-status">
    <div>
      <span>Capture status</span>
      <strong>{captureStatusText}</strong>
    </div>
    <div>
      <span>Motion frames</span>
      <strong>{poseFrameCount}</strong>
    </div>
    <div>
      <span>Last pose</span>
      <strong>
        {lastPoseAt ? `${Math.round(lastPoseAgeMs)} ms ago` : "No pose yet"}
      </strong>
    </div>
    <button on:click={resetCaptureLock} disabled={!capture.active}>
      Reset Capture Lock
    </button>
  </section>

  <section class="angle-inspector">
    <article class="angle-main">
      <span>Gravity vector</span>
      <strong>
        {formatGravity(liveGravity.x)} / {formatGravity(liveGravity.y)} / {formatGravity(liveGravity.z)}
      </strong>
      <em>Closest calibrated direction: {liveClosestDirection}</em>
    </article>
    <article>
      <span>Neutral</span>
      <strong>{formatGravityAngle(liveAngles.neutral)}</strong>
      <em>score {formatPercent(liveScores.neutral)}</em>
    </article>
    <article>
      <span>Forward W</span>
      <strong>{formatGravityAngle(liveAngles.forward)}</strong>
      <em>projection {formatPercent(liveScores.forward)}</em>
    </article>
    <article>
      <span>Back S</span>
      <strong>{formatGravityAngle(liveAngles.backward)}</strong>
      <em>projection {formatPercent(liveScores.backward)}</em>
    </article>
    <article>
      <span>Left A</span>
      <strong>{formatGravityAngle(liveAngles.left)}</strong>
      <em>projection {formatPercent(liveScores.left)}</em>
    </article>
    <article>
      <span>Right D</span>
      <strong>{formatGravityAngle(liveAngles.right)}</strong>
      <em>projection {formatPercent(liveScores.right)}</em>
    </article>
  </section>

  {#if connection.connected && !canCapture}
    <section class="capture-warning">
      Connected, but the trainer has not received enough live gravity/gyro
      frames yet. Upload the V2 firmware and wait until Live Motion updates.
    </section>
  {/if}

  <section class="label-grid">
    {#each TRAINING_LABELS as label}
      <article class="label-card" style={`--label-color:${label.color}`}>
        <div class="label-head">
          <div>
            <span>{label.keys}</span>
            <h3>{label.title}</h3>
            <em>{datasetSessionStats[label.id] || 0} sessions</em>
          </div>
          <strong>{datasetStats[label.id] || 0}</strong>
        </div>
        <p>{label.description}</p>
        <div class="mini-keys">
          <kbd class:active={keyClass(label.id, "w")}>W</kbd>
          <kbd class:active={keyClass(label.id, "a")}>A</kbd>
          <kbd class:active={keyClass(label.id, "s")}>S</kbd>
          <kbd class:active={keyClass(label.id, "d")}>D</kbd>
        </div>
        <div class="sample-meter">
          <span style={`width:${Math.min((datasetStats[label.id] || 0) / recommendedPerLabel, 1) * 100}%`} />
        </div>
        <button
          on:click={() => startCapture(label.id)}
          disabled={capture.active}
        >
          {capture.active && capture.label === label.id
            ? `Capturing ${capture.collected}`
            : `Capture ${label.keys}`}
        </button>
      </article>
    {/each}
  </section>

  {#if capture.active}
    <section class="capture-banner">
      <strong>Recording {capture.label}</strong>
      <span>{Math.ceil(capture.remainingMs / 1000)}s remaining</span>
    </section>
  {/if}

  <section class="panel-card dataset-inspector">
    <div class="panel-head">
      <div>
        <p class="eyebrow">Dataset Inspector</p>
        <h2>Labeled samples</h2>
        <p>
          Data is stored in browser localStorage and should be exported as JSON
          before clearing browser data or changing computers.
        </p>
      </div>
      <div class="inspector-actions">
        <select bind:value={datasetFilter}>
          <option value="ALL">All labels</option>
          {#each TRAINING_LABELS as label}
            <option value={label.id}>{label.id} - {label.title}</option>
          {/each}
        </select>
        <button on:click={selectVisibleSamples} disabled={!visibleDataset.length}>
          Select Visible
        </button>
        <button on:click={clearSelection} disabled={!selectedSampleIds.length}>
          Clear Selection
        </button>
        <button class="danger" on:click={deleteSelectedSamples} disabled={!selectedSampleIds.length}>
          Delete Selected
        </button>
        <button class="danger" on:click={deleteFilteredSamples} disabled={!dataset.length}>
          Delete Filtered
        </button>
      </div>
    </div>

    <div class="label-summary">
      {#each TRAINING_LABELS as label}
        <button
          class:active={datasetFilter === label.id}
          style={`--label-color:${label.color}`}
          on:click={() => (datasetFilter = label.id)}
        >
          <span>{label.id}</span>
          <strong>{datasetStats[label.id] || 0}</strong>
        </button>
      {/each}
      <button
        class:active={datasetFilter === "ALL"}
        style="--label-color:#202124"
        on:click={() => (datasetFilter = "ALL")}
      >
        <span>ALL</span>
        <strong>{dataset.length}</strong>
      </button>
    </div>

    <div class="sample-table">
      <div class="table-head">
        <span>Select</span>
        <span>Label</span>
        <span>Gravity</span>
        <span>Angle N</span>
        <span>Closest</span>
        <span>Captured</span>
      </div>
      <div class="sample-scroll">
        {#if visibleDataset.length}
          {#each visibleDataset as sample}
            <button
              class="sample-row"
              class:selected={isSampleSelected(sample.id)}
              on:click={() => toggleSampleSelection(sample.id)}
            >
              <span>{isSampleSelected(sample.id) ? "Selected" : "Select"}</span>
              <strong>{sample.label}</strong>
              <span>
                {formatGravity(sample.summary?.gravity?.mean?.x)} /
                {formatGravity(sample.summary?.gravity?.mean?.y)} /
                {formatGravity(sample.summary?.gravity?.mean?.z)}
              </span>
              <span>{formatGravityAngle(sample.summary?.angles?.neutral)}</span>
              <span>{closestAngleLabel(sample.summary?.angles)}</span>
              <span>{sample.createdAt ? new Date(sample.createdAt).toLocaleString() : "-"}</span>
            </button>
          {/each}
        {:else}
          <p class="empty-state">
          No samples for this filter. Connect the board, wait for Live Motion to
          update, then capture a labeled class.
          </p>
        {/if}
      </div>
    </div>
  </section>

  <section class="training-layout">
    <article class="panel-card">
      <div class="panel-head">
        <div>
          <p class="eyebrow">Step 2</p>
          <h2>Train MLP classifier</h2>
        </div>
        <button class="primary" on:click={trainModel} disabled={!readyToTrain || training.active}>
          {training.active ? "Training..." : "Train Model"}
        </button>
      </div>

      <div class="model-spec">
        <div>
          <span>Network</span>
          <strong>Gravity/Gyro V2 -> Dense 32 ReLU -> Dense 16 ReLU -> 4 Sigmoid</strong>
        </div>
        <div>
          <span>Training</span>
          <strong>Adam, LR 0.001, batch 16, BCE, early stopping</strong>
        </div>
        <div>
          <span>Runtime</span>
          <strong>W main threshold, lower A/D combo threshold, max {maxActiveKeys} keys</strong>
        </div>
      </div>

      <div class="threshold-panel">
        <label>
          <span>On threshold</span>
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            bind:value={keyOnThreshold}
            on:change={persistRuntimeControls}
          />
        </label>
        <label>
          <span>Off threshold</span>
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            bind:value={keyOffThreshold}
            on:change={persistRuntimeControls}
          />
        </label>
        <label>
          <span>Max active keys</span>
          <input
            type="number"
            min="1"
            max="2"
            step="1"
            bind:value={maxActiveKeys}
            on:change={persistRuntimeControls}
          />
        </label>
        <label>
          <span>Combo steer threshold</span>
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            bind:value={comboSteerThreshold}
            on:change={persistRuntimeControls}
          />
        </label>
        <label>
          <span>Combo steer margin</span>
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            bind:value={comboSteerMargin}
            on:change={persistRuntimeControls}
          />
        </label>
      </div>

      <div class="metric-grid">
        <div>
          <span>Train Acc</span>
          <strong>{formatPercent(model?.metrics?.train?.accuracy)}</strong>
        </div>
        <div>
          <span>Val Acc</span>
          <strong>{formatPercent(model?.metrics?.validation?.accuracy)}</strong>
        </div>
        <div>
          <span>Val Loss</span>
          <strong>{formatLoss(model?.metrics?.validation?.loss)}</strong>
        </div>
        <div>
          <span>Epoch</span>
          <strong>{training.progress?.epoch || model?.training?.history?.length || "-"}</strong>
        </div>
      </div>

      {#if model?.metrics?.confusionMatrix}
        <div class="confusion">
          <h3>Validation confusion matrix</h3>
          <div class="matrix-grid" style={`--matrix-size:${confusionLabels.length}`}>
            <span />
            {#each confusionLabels as label}
              <b>{label}</b>
            {/each}
            {#each model.metrics.confusionMatrix as row, rowIndex}
              <b>{model.labels[rowIndex]}</b>
              {#each row as value}
                <span>{value}</span>
              {/each}
            {/each}
          </div>
        </div>
      {/if}
    </article>

    <article class="panel-card live-card">
      <p class="eyebrow">Step 3</p>
      <h2>Live prediction</h2>
      <div class="prediction-display">
        <span>ML Result</span>
        <strong>{livePrediction?.label || "NO MODEL"}</strong>
        <em>
          Confidence {formatPercent(livePrediction?.confidence)}
          · Mask {livePrediction?.keyMask ?? 0}
        </em>
      </div>
      <em class="prediction-meta">
        Confidence {formatPercent(livePrediction?.confidence)}
        | Mask {livePrediction?.keyMask ?? 0}
      </em>
      <div class="probability-list">
        {#each OUTPUT_KEY_IDS as key}
          <div>
            <span>{key}</span>
            <div>
              <i
                style={`width:${((livePrediction?.outputs?.find((item) => item.key === key)?.value || 0) * 100).toFixed(1)}%; background:${labelColorMap[key] || "#1a73e8"}`}
              />
            </div>
            <strong>
              {formatPercent(livePrediction?.outputs?.find((item) => item.key === key)?.value)}
            </strong>
          </div>
        {/each}
      </div>
    </article>
  </section>

  <section class="panel-card export-card">
    <div>
      <p class="eyebrow">Step 4</p>
      <h2>Data and model files</h2>
      <p>
        Dataset samples are saved in browser storage as soon as they are
        captured. Export JSON files before changing computers or clearing the
        browser cache.
      </p>
    </div>
    <div class="export-actions">
      <button on:click={exportDataset} disabled={!dataset.length}>Export Dataset</button>
      <button on:click={() => datasetFileInput.click()}>Import Dataset</button>
      <button on:click={exportModel} disabled={!model}>Export Model</button>
      <button on:click={exportArduinoModel} disabled={!model}>Export Arduino Model</button>
      <button on:click={compileFirmwareWithModel} disabled={!model || firmwareBuild.active}>
        {firmwareBuild.active ? "Compiling..." : "Write + Compile Firmware"}
      </button>
      <button on:click={() => modelFileInput.click()}>Import Model</button>
      <button class="danger" on:click={clearDataset} disabled={!dataset.length}>Clear Dataset</button>
      <button class="danger" on:click={clearModel} disabled={!model}>Clear Model</button>
      <button class="danger" on:click={clearAllTrainerData} disabled={!dataset.length && !model}>Clear All</button>
    </div>
    <div class="firmware-build-detail">
      <strong>{firmwareBuildTitle}</strong>
      <span>{firmwareBuildTimestamp}</span>
      <em>{firmwareBuildSummary}</em>
    </div>
    <input
      bind:this={datasetFileInput}
      type="file"
      accept="application/json"
      on:change={importDataset}
      hidden
    />
    <input
      bind:this={modelFileInput}
      type="file"
      accept="application/json"
      on:change={importModel}
      hidden
    />
  </section>
</main>

<style lang="scss">
  :global(body) {
    background: #f8fafd;
  }

  .trainer-shell {
    min-height: 100vh;
    padding: 36px clamp(18px, 4vw, 56px) 56px;
    background:
      radial-gradient(circle at 18% 0%, rgba(66, 133, 244, 0.14), transparent 28%),
      radial-gradient(circle at 88% 12%, rgba(251, 188, 4, 0.18), transparent 24%),
      #f8fafd;
    color: #202124;
  }

  .trainer-shell :global(button),
  .trainer-shell :global(a.secondary) {
    width: auto;
    height: auto;
    min-height: 44px;
    border: 1px solid #dadce0;
    border-radius: 999px;
    padding: 0 18px;
    background: #fff;
    color: #202124;
    font: 700 14px/1 "Google Sans Mono", "Roboto Mono", monospace;
    text-decoration: none;
    display: inline-grid;
    place-items: center;
    cursor: pointer;
  }

  .trainer-shell :global(button:hover),
  .trainer-shell :global(a.secondary:hover) {
    background: #f1f3f4;
    color: #202124;
  }

  .trainer-shell :global(button:disabled) {
    opacity: 0.48;
    cursor: not-allowed;
  }

  .trainer-shell :global(button.primary) {
    border-color: #1a73e8;
    background: #1a73e8;
    color: #fff;
  }

  .trainer-shell :global(button.danger) {
    border-color: rgba(234, 67, 53, 0.35);
    color: #b3261e;
  }

  .trainer-hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 28px;
    align-items: start;
  }

  .eyebrow {
    margin: 0 0 10px;
    color: #1a73e8;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  h1,
  h2,
  h3,
  p {
    margin-top: 0;
  }

  h1 {
    max-width: 940px;
    color: #202124;
    font-size: clamp(44px, 7vw, 88px);
    line-height: 0.9;
    letter-spacing: -0.07em;
  }

  h2 {
    margin-bottom: 12px;
    color: #202124;
  }

  .hero-copy {
    max-width: 780px;
    color: #5f6368;
    font-size: 18px;
    line-height: 1.6;
  }

  .hero-actions,
  .export-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: flex-start;
  }

  .status-strip,
  .trainer-steps,
  .label-grid,
  .training-layout {
    display: grid;
    gap: 16px;
    margin-top: 26px;
  }

  .status-strip {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .trainer-steps {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .label-grid {
    grid-template-columns: repeat(5, minmax(150px, 1fr));
  }

  .training-layout {
    grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
  }

  .status-strip article,
  .step-card,
  .label-card,
  .panel-card,
  .error-card {
    border: 1px solid #e8eaed;
    border-radius: 28px;
    background: rgba(255, 255, 255, 0.92);
    box-shadow: 0 18px 42px rgba(60, 64, 67, 0.08);
  }

  .status-strip article,
  .step-card,
  .label-card,
  .panel-card {
    padding: 20px;
    min-width: 0;
  }

  .status-strip span,
  .status-strip em,
  .step-card em,
  .model-spec span,
  .metric-grid span,
  .prediction-display span,
  .prediction-display em,
  .export-card p {
    color: #5f6368;
    font-style: normal;
  }

  .status-strip strong,
  .status-strip em {
    display: block;
  }

  .status-strip strong {
    margin: 8px 0 4px;
    font-size: 18px;
    overflow-wrap: anywhere;
  }

  .status-strip em {
    overflow-wrap: anywhere;
  }

  .error-card {
    margin-top: 20px;
    padding: 18px 20px;
    color: #b3261e;
    background: #fce8e6;
  }

  .data-message,
  .capture-warning {
    margin-top: 18px;
    border: 1px solid #d2e3fc;
    border-radius: 18px;
    padding: 14px 18px;
    background: #e8f0fe;
    color: #174ea6;
  }

  .capture-warning {
    border-color: #fdd663;
    background: #fef7e0;
    color: #8a5b00;
  }

  .capture-status {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
    gap: 12px;
    align-items: center;
    margin-top: 18px;
    border: 1px solid #e8eaed;
    border-radius: 24px;
    padding: 16px;
    background: rgba(255, 255, 255, 0.9);
  }

  .capture-status div {
    display: grid;
    gap: 4px;
  }

  .capture-status span {
    color: #5f6368;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .capture-status strong {
    color: #202124;
  }

  .angle-inspector {
    display: grid;
    grid-template-columns: minmax(220px, 1.35fr) repeat(5, minmax(130px, 1fr));
    gap: 12px;
    margin-top: 14px;
  }

  .angle-inspector article {
    display: grid;
    gap: 6px;
    border: 1px solid #e8eaed;
    border-radius: 20px;
    padding: 16px;
    background: rgba(255, 255, 255, 0.9);
  }

  .angle-inspector .angle-main {
    background: linear-gradient(135deg, #202124, #3c4043);
    color: #fff;
  }

  .angle-inspector span {
    color: #5f6368;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .angle-inspector .angle-main span,
  .angle-inspector .angle-main em {
    color: rgba(255, 255, 255, 0.68);
  }

  .angle-inspector strong {
    color: #202124;
    font-size: 20px;
  }

  .angle-inspector .angle-main strong {
    color: #fff;
  }

  .angle-inspector em {
    color: #5f6368;
    font-size: 12px;
    font-style: normal;
  }

  .step-card span {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    margin-bottom: 18px;
    border-radius: 50%;
    background: #e8f0fe;
    color: #1a73e8;
    font-weight: 800;
  }

  .step-card strong,
  .step-card em {
    display: block;
  }

  .section-head {
    display: grid;
    grid-template-columns: 1fr minmax(280px, 520px);
    gap: 22px;
    align-items: end;
    margin-top: 34px;
  }

  .section-head p {
    color: #5f6368;
    line-height: 1.6;
  }

  .label-card {
    display: grid;
    gap: 14px;
    border-top: 6px solid var(--label-color);
  }

  .label-head {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 12px;
  }

  .label-head span {
    color: var(--label-color);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.12em;
  }

  .label-head h3 {
    margin: 4px 0 0;
    color: #202124;
  }

  .label-head em {
    display: block;
    margin-top: 4px;
    color: #5f6368;
    font-size: 12px;
    font-style: normal;
  }

  .label-head strong {
    font-size: 32px;
    color: var(--label-color);
  }

  .label-card p {
    min-height: 54px;
    color: #5f6368;
    font-size: 14px;
    line-height: 1.45;
  }

  .mini-keys {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }

  kbd {
    display: grid;
    min-height: 30px;
    place-items: center;
    border: 1px solid #dadce0;
    border-radius: 10px;
    background: #fff;
    color: #5f6368;
    font-weight: 800;
  }

  kbd.active {
    border-color: var(--label-color);
    background: color-mix(in srgb, var(--label-color) 16%, white);
    color: var(--label-color);
  }

  .sample-meter {
    height: 8px;
    overflow: hidden;
    border-radius: 999px;
    background: #edf0f5;
  }

  .sample-meter span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--label-color);
  }

  .label-card button {
    border-color: var(--label-color);
    color: var(--label-color);
  }

  .capture-banner {
    position: sticky;
    bottom: 18px;
    z-index: 5;
    display: flex;
    justify-content: space-between;
    gap: 18px;
    margin: 22px auto 0;
    width: min(520px, calc(100vw - 40px));
    padding: 16px 20px;
    border-radius: 999px;
    background: #202124;
    color: #fff;
    box-shadow: 0 18px 48px rgba(32, 33, 36, 0.28);
  }

  .dataset-inspector {
    margin-top: 24px;
  }

  .dataset-inspector p {
    max-width: 720px;
    color: #5f6368;
    line-height: 1.55;
  }

  .inspector-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: flex-end;
  }

  .inspector-actions select {
    min-height: 44px;
    border: 1px solid #dadce0;
    border-radius: 999px;
    padding: 0 18px;
    background: #fff;
    color: #202124;
    font: 700 14px/1 "Google Sans Mono", "Roboto Mono", monospace;
  }

  .label-summary {
    display: grid;
    grid-template-columns: repeat(6, minmax(86px, 1fr));
    gap: 10px;
    margin-top: 20px;
  }

  .label-summary button {
    display: grid;
    gap: 4px;
    justify-items: start;
    min-height: 68px;
    border-color: color-mix(in srgb, var(--label-color) 48%, #dadce0);
    border-radius: 18px;
    color: var(--label-color);
  }

  .label-summary button.active {
    background: color-mix(in srgb, var(--label-color) 12%, white);
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--label-color) 72%, white);
  }

  .label-summary span {
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.12em;
  }

  .label-summary strong {
    font-size: 24px;
  }

  .sample-table {
    display: grid;
    gap: 8px;
    margin-top: 20px;
  }

  .sample-scroll {
    display: grid;
    gap: 8px;
    max-height: 380px;
    overflow-y: auto;
    padding-right: 6px;
  }

  .sample-scroll::-webkit-scrollbar {
    width: 10px;
  }

  .sample-scroll::-webkit-scrollbar-track {
    border-radius: 999px;
    background: #edf0f5;
  }

  .sample-scroll::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background: #c7d0dd;
  }

  .table-head,
  .sample-row {
    display: grid;
    grid-template-columns: 92px 92px minmax(180px, 1.4fr) minmax(88px, 0.8fr) minmax(88px, 0.8fr) minmax(150px, 1fr);
    gap: 10px;
    align-items: center;
  }

  .table-head {
    padding: 0 14px;
    color: #5f6368;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .sample-row {
    width: 100%;
    min-height: 52px;
    border-radius: 16px;
    justify-items: start;
    text-align: left;
  }

  .sample-row.selected {
    border-color: #1a73e8;
    background: #e8f0fe;
  }

  .sample-row strong {
    color: #202124;
  }

  .empty-state {
    margin: 0;
    border: 1px dashed #dadce0;
    border-radius: 18px;
    padding: 18px;
    color: #5f6368;
  }

  .panel-head {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 18px;
  }

  .model-spec,
  .metric-grid {
    display: grid;
    gap: 12px;
    margin-top: 18px;
  }

  .model-spec {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .model-spec div,
  .metric-grid div {
    border: 1px solid #edf0f5;
    border-radius: 18px;
    padding: 14px;
    background: #fbfcff;
  }

  .model-spec strong,
  .metric-grid strong {
    display: block;
    margin-top: 6px;
  }

  .metric-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .metric-grid strong {
    font-size: 26px;
  }

  .threshold-panel {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 12px;
    margin-top: 14px;
  }

  .threshold-panel label {
    display: grid;
    gap: 8px;
    border: 1px solid #edf0f5;
    border-radius: 18px;
    padding: 14px;
    background: #fbfcff;
  }

  .threshold-panel span {
    color: #5f6368;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .threshold-panel input {
    min-height: 42px;
    border: 1px solid #dadce0;
    border-radius: 12px;
    padding: 0 12px;
    background: #fff;
    color: #202124;
    font: 800 18px/1 "Google Sans Mono", "Roboto Mono", monospace;
  }

  .confusion {
    margin-top: 22px;
  }

  .matrix-grid {
    display: grid;
    grid-template-columns: 54px repeat(var(--matrix-size), minmax(34px, 1fr));
    gap: 6px;
    overflow-x: auto;
  }

  .matrix-grid b,
  .matrix-grid span {
    display: grid;
    min-height: 32px;
    place-items: center;
    border-radius: 8px;
    font-size: 12px;
  }

  .matrix-grid b {
    color: #5f6368;
  }

  .matrix-grid span {
    background: #e8f0fe;
    color: #174ea6;
    font-weight: 800;
  }

  .prediction-display {
    display: grid;
    gap: 4px;
    margin: 10px 0 22px;
    border-radius: 24px;
    padding: 24px;
    background: linear-gradient(135deg, #202124, #3c4043);
    color: #fff;
  }

  .prediction-display span,
  .prediction-display em {
    color: rgba(255, 255, 255, 0.72);
  }

  .prediction-display > em {
    display: none;
  }

  .prediction-display strong {
    font-size: clamp(44px, 8vw, 76px);
    line-height: 1;
  }

  .prediction-meta {
    display: block;
    margin: -10px 0 18px;
    color: #5f6368;
    font-style: normal;
  }

  .probability-list {
    display: grid;
    gap: 12px;
  }

  .probability-list > div {
    display: grid;
    grid-template-columns: 72px 1fr 52px;
    gap: 10px;
    align-items: center;
  }

  .probability-list span,
  .probability-list strong {
    color: #3c4043;
  }

  .probability-list div div {
    height: 10px;
    overflow: hidden;
    border-radius: 999px;
    background: #edf0f5;
  }

  .probability-list i {
    display: block;
    height: 100%;
    border-radius: inherit;
  }

  .export-card {
    display: grid;
    grid-template-columns: 1fr;
    gap: 18px;
    align-items: start;
    margin-top: 16px;
  }

  .export-card > div:first-child {
    max-width: 820px;
  }

  .export-card h2 {
    max-width: none;
  }

  .export-card p {
    max-width: 720px;
    line-height: 1.55;
  }

  .export-actions button {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .firmware-build-detail {
    grid-column: 1 / -1;
    display: grid;
    gap: 6px;
    border: 1px solid #edf0f5;
    border-radius: 18px;
    padding: 14px 16px;
    background: #fbfcff;
  }

  .firmware-build-detail strong {
    color: #202124;
  }

  .firmware-build-detail span,
  .firmware-build-detail em {
    color: #5f6368;
    font-style: normal;
  }

  @media (max-width: 1180px) {
    .status-strip,
    .trainer-steps {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .angle-inspector {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .label-grid {
      grid-template-columns: repeat(3, minmax(180px, 1fr));
    }
  }

  @media (max-width: 860px) {
    .trainer-hero,
    .section-head,
    .training-layout,
    .export-card {
      grid-template-columns: 1fr;
    }

    .hero-actions,
    .export-actions {
      justify-content: flex-start;
    }

    .status-strip,
    .trainer-steps,
    .angle-inspector,
    .label-grid,
    .model-spec,
    .metric-grid,
    .threshold-panel,
    .capture-status {
      grid-template-columns: 1fr;
    }
  }
</style>
