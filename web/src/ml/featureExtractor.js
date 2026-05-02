export const TRAINING_LABELS = [
  {
    id: "NEUTRAL",
    title: "Neutral",
    keys: "NONE",
    color: "#5f6368",
    description: "Board balanced, no key output.",
  },
  {
    id: "W",
    title: "Forward",
    keys: "W",
    color: "#34a853",
    description: "Forward / accelerate intent.",
  },
  {
    id: "A",
    title: "Left",
    keys: "A",
    color: "#4285f4",
    description: "Steer left intent.",
  },
  {
    id: "S",
    title: "Back",
    keys: "S",
    color: "#ea4335",
    description: "Brake or reverse intent.",
  },
  {
    id: "D",
    title: "Right",
    keys: "D",
    color: "#fbbc04",
    description: "Steer right intent.",
  },
];

export const FEATURE_VERSION = 2;
export const FEATURE_WINDOW_MS = 650;
export const FEATURE_NAMES = [
  "gravity_x_mean",
  "gravity_y_mean",
  "gravity_z_mean",
  "gravity_x_std",
  "gravity_y_std",
  "gravity_z_std",
  "gravity_x_delta",
  "gravity_y_delta",
  "gravity_z_delta",
  "angle_to_neutral",
  "angle_to_forward",
  "angle_to_backward",
  "angle_to_left",
  "angle_to_right",
  "forward_score",
  "backward_score",
  "left_score",
  "right_score",
  "gyro_x_mean",
  "gyro_y_mean",
  "gyro_z_mean",
  "gyro_x_std",
  "gyro_y_std",
  "gyro_z_std",
  "gyro_x_delta",
  "gyro_y_delta",
  "gyro_z_delta",
  "gyro_energy_mean",
  "gravity_jitter",
  "direction_confidence",
  "neutral_score",
];

function average(values) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function magnitude(vector) {
  return Math.sqrt(
    vector.x * vector.x + vector.y * vector.y + vector.z * vector.z,
  );
}

function normalizeVector(vector, fallback = { x: 0, y: 0, z: 1 }) {
  const length = magnitude(vector);
  if (!Number.isFinite(length) || length < 0.000001) {
    return fallback;
  }

  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function angleBetweenDegrees(a, b) {
  const normalizedA = normalizeVector(a);
  const normalizedB = normalizeVector(b);
  return (Math.acos(clamp(dot(normalizedA, normalizedB), -1, 1)) * 180) / Math.PI;
}

function subtractVector(a, b) {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
  };
}

function summarizeAxis(samples, axis) {
  const values = samples.map((sample) => Number(sample[axis]) || 0);
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));

  return {
    mean,
    std: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
    delta: values[values.length - 1] - values[0],
  };
}

function summarizeVector(samples, prefix) {
  return {
    x: summarizeAxis(samples, `${prefix}X`),
    y: summarizeAxis(samples, `${prefix}Y`),
    z: summarizeAxis(samples, `${prefix}Z`),
  };
}

function getWindowSamples(samples, windowMs, options = {}) {
  if (options.useAllSamples) {
    return samples;
  }

  const now = performance.now();
  const windowSamples = samples.filter((sample) => now - sample.time <= windowMs);

  if (windowSamples.length) {
    return windowSamples;
  }

  const lastSample = samples[samples.length - 1];
  return lastSample ? [lastSample] : [];
}

function vectorMean(stats) {
  return normalizeVector({
    x: stats.x.mean,
    y: stats.y.mean,
    z: stats.z.mean,
  });
}

function vectorFromCalibration(calibration, key, fallback) {
  const value = calibration?.[key]?.gravity;
  if (!value) {
    return fallback;
  }

  return normalizeVector(value, fallback);
}

function createDirectionAxes(calibration) {
  const neutral = vectorFromCalibration(calibration, "neutral", {
    x: 0,
    y: 0,
    z: 1,
  });
  const forward = vectorFromCalibration(calibration, "forward", neutral);
  const backward = vectorFromCalibration(calibration, "backward", neutral);
  const left = vectorFromCalibration(calibration, "left", neutral);
  const right = vectorFromCalibration(calibration, "right", neutral);

  return {
    neutral,
    forward,
    backward,
    left,
    right,
    forwardAxis: normalizeVector(subtractVector(forward, backward), {
      x: 1,
      y: 0,
      z: 0,
    }),
    leftAxis: normalizeVector(subtractVector(left, right), {
      x: 0,
      y: 1,
      z: 0,
    }),
  };
}

export function createMotionSample(sourceMotion) {
  const gravity = normalizeVector({
    x: Number(sourceMotion?.gravityX) || 0,
    y: Number(sourceMotion?.gravityY) || 0,
    z: Number(sourceMotion?.gravityZ) || 0,
  });

  return {
    time: performance.now(),
    gravityX: gravity.x,
    gravityY: gravity.y,
    gravityZ: gravity.z,
    gyroX: Number(sourceMotion?.gyroX) || 0,
    gyroY: Number(sourceMotion?.gyroY) || 0,
    gyroZ: Number(sourceMotion?.gyroZ) || 0,
  };
}

export function createPoseSample(sourcePose) {
  return {
    time: performance.now(),
    pitch: Number(sourcePose?.pitch) || 0,
    roll: Number(sourcePose?.roll) || 0,
    yaw: Number(sourcePose?.yaw) || 0,
  };
}

export function createCalibrationFromDataset(dataset) {
  const vectorForLabel = (labelId) => {
    const samples = dataset.filter(
      (sample) => sample.label === labelId && sample.summary?.gravity,
    );
    if (!samples.length) {
      return null;
    }

    return normalizeVector({
      x: average(samples.map((sample) => sample.summary.gravity.mean.x)),
      y: average(samples.map((sample) => sample.summary.gravity.mean.y)),
      z: average(samples.map((sample) => sample.summary.gravity.mean.z)),
    });
  };

  return {
    neutral: { gravity: vectorForLabel("NEUTRAL") },
    forward: { gravity: vectorForLabel("W") },
    backward: { gravity: vectorForLabel("S") },
    left: { gravity: vectorForLabel("A") },
    right: { gravity: vectorForLabel("D") },
  };
}

export function extractFeatureWindow(
  motionSamples,
  calibration = {},
  _baselinePose = null,
  options = {},
) {
  const windowMs = options.windowMs || FEATURE_WINDOW_MS;
  const samples = getWindowSamples(motionSamples, windowMs, options);

  if (!samples.length) {
    return null;
  }

  const gravity = summarizeVector(samples, "gravity");
  const gyro = summarizeVector(samples, "gyro");
  const gravityMean = vectorMean(gravity);
  const axes = createDirectionAxes(calibration);
  const angleNeutral = angleBetweenDegrees(gravityMean, axes.neutral);
  const angleForward = angleBetweenDegrees(gravityMean, axes.forward);
  const angleBackward = angleBetweenDegrees(gravityMean, axes.backward);
  const angleLeft = angleBetweenDegrees(gravityMean, axes.left);
  const angleRight = angleBetweenDegrees(gravityMean, axes.right);
  const forwardProjection = dot(gravityMean, axes.forwardAxis);
  const leftProjection = dot(gravityMean, axes.leftAxis);
  const forwardScore = Math.max(0, forwardProjection);
  const backwardScore = Math.max(0, -forwardProjection);
  const leftScore = Math.max(0, leftProjection);
  const rightScore = Math.max(0, -leftProjection);
  const gyroEnergyMean = average(
    samples.map((sample) =>
      magnitude({
        x: sample.gyroX,
        y: sample.gyroY,
        z: sample.gyroZ,
      }),
    ),
  );
  const gravityJitter = Math.sqrt(
    gravity.x.std * gravity.x.std +
      gravity.y.std * gravity.y.std +
      gravity.z.std * gravity.z.std,
  );
  const directionConfidence = Math.max(
    forwardScore,
    backwardScore,
    leftScore,
    rightScore,
  );
  const neutralScore = clamp(1 - angleNeutral / 90, 0, 1);
  const features = [
    gravity.x.mean,
    gravity.y.mean,
    gravity.z.mean,
    gravity.x.std,
    gravity.y.std,
    gravity.z.std,
    gravity.x.delta,
    gravity.y.delta,
    gravity.z.delta,
    angleNeutral,
    angleForward,
    angleBackward,
    angleLeft,
    angleRight,
    forwardScore,
    backwardScore,
    leftScore,
    rightScore,
    gyro.x.mean,
    gyro.y.mean,
    gyro.z.mean,
    gyro.x.std,
    gyro.y.std,
    gyro.z.std,
    gyro.x.delta,
    gyro.y.delta,
    gyro.z.delta,
    gyroEnergyMean,
    gravityJitter,
    directionConfidence,
    neutralScore,
  ];

  return {
    features,
    featureVersion: FEATURE_VERSION,
    window: samples.map((sample) => ({
      gravityX: sample.gravityX,
      gravityY: sample.gravityY,
      gravityZ: sample.gravityZ,
      gyroX: sample.gyroX,
      gyroY: sample.gyroY,
      gyroZ: sample.gyroZ,
    })),
    summary: {
      gravity: {
        mean: gravityMean,
        x: gravity.x,
        y: gravity.y,
        z: gravity.z,
      },
      gyro: {
        x: gyro.x,
        y: gyro.y,
        z: gyro.z,
        energyMean: gyroEnergyMean,
      },
      angles: {
        neutral: angleNeutral,
        forward: angleForward,
        backward: angleBackward,
        left: angleLeft,
        right: angleRight,
      },
      scores: {
        forward: forwardScore,
        backward: backwardScore,
        left: leftScore,
        right: rightScore,
        neutral: neutralScore,
        directionConfidence,
      },
      sampleCount: samples.length,
      windowMs,
      capturedAt: Date.now(),
    },
  };
}

export function labelToKeys(labelId) {
  return {
    w: labelId === "W" || labelId === "WA" || labelId === "WD",
    a: labelId === "A" || labelId === "WA",
    s: labelId === "S",
    d: labelId === "D" || labelId === "WD",
    combo: labelId === "NEUTRAL" ? "NONE" : labelId,
  };
}
