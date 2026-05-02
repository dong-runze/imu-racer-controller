import {
  FEATURE_NAMES,
  FEATURE_VERSION,
  TRAINING_LABELS,
  labelToKeys,
} from "./featureExtractor";

export const OUTPUT_KEY_IDS = ["W", "A", "S", "D"];
export const DEFAULT_KEY_ON_THRESHOLD = 0.6;
export const DEFAULT_KEY_OFF_THRESHOLD = 0.45;
export const DEFAULT_MAX_ACTIVE_KEYS = 2;
export const DEFAULT_COMBO_STEER_THRESHOLD = 0.35;
export const DEFAULT_COMBO_STEER_MARGIN = 0.08;

const LABEL_IDS = TRAINING_LABELS.map((label) => label.id);
const CONFUSION_LABEL_IDS = ["NEUTRAL", "W", "A", "S", "D", "WA", "WD"];
const KEY_BITS = {
  W: 1 << 0,
  A: 1 << 1,
  S: 1 << 2,
  D: 1 << 3,
};
const DEFAULT_OPTIONS = {
  epochs: 120,
  batchSize: 16,
  learningRate: 0.001,
  validationSplit: 0.2,
  patience: 18,
  keyOnThreshold: DEFAULT_KEY_ON_THRESHOLD,
  keyOffThreshold: DEFAULT_KEY_OFF_THRESHOLD,
  maxActiveKeys: DEFAULT_MAX_ACTIVE_KEYS,
  comboSteerThreshold: DEFAULT_COMBO_STEER_THRESHOLD,
  comboSteerMargin: DEFAULT_COMBO_STEER_MARGIN,
};
const EPSILON = 1e-8;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function randomWeight(fanIn) {
  return (Math.random() * 2 - 1) * Math.sqrt(2 / fanIn);
}

function createMatrix(rows, columns, fill = 0) {
  return Array.from({ length: rows }, () => Array(columns).fill(fill));
}

function createVector(length, fill = 0) {
  return Array(length).fill(fill);
}

function createLayer(inputSize, outputSize) {
  return {
    weights: createMatrix(outputSize, inputSize).map((row) =>
      row.map(() => randomWeight(inputSize)),
    ),
    bias: createVector(outputSize, 0),
  };
}

function cloneLayerShape(layer) {
  return {
    weights: createMatrix(layer.weights.length, layer.weights[0].length, 0),
    bias: createVector(layer.bias.length, 0),
  };
}

function createAdamState(layers) {
  return {
    t: 0,
    m: layers.map(cloneLayerShape),
    v: layers.map(cloneLayerShape),
  };
}

function standardizeFeature(features, standardizer) {
  return features.map(
    (value, index) =>
      (value - standardizer.mean[index]) / (standardizer.std[index] || 1),
  );
}

function createStandardizer(dataset) {
  const featureCount = dataset[0].features.length;
  const mean = createVector(featureCount, 0);
  const std = createVector(featureCount, 1);

  for (let index = 0; index < featureCount; index += 1) {
    const values = dataset.map((sample) => sample.features[index]);
    const valueMean =
      values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    const variance =
      values.reduce((sum, value) => sum + (value - valueMean) ** 2, 0) /
      Math.max(values.length, 1);
    mean[index] = valueMean;
    std[index] = Math.sqrt(variance) || 1;
  }

  return { mean, std };
}

function labelToTarget(labelId) {
  const keys = labelToKeys(labelId);
  return OUTPUT_KEY_IDS.map((key) => (keys[key.toLowerCase()] ? 1 : 0));
}

function relu(values) {
  return values.map((value) => Math.max(0, value));
}

function reluDerivative(values) {
  return values.map((value) => (value > 0 ? 1 : 0));
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }

  const z = Math.exp(value);
  return z / (1 + z);
}

function layerForward(input, layer) {
  return layer.weights.map(
    (row, rowIndex) =>
      row.reduce((sum, weight, columnIndex) => sum + weight * input[columnIndex], 0) +
      layer.bias[rowIndex],
  );
}

function forward(input, layers) {
  const z1 = layerForward(input, layers[0]);
  const a1 = relu(z1);
  const z2 = layerForward(a1, layers[1]);
  const a2 = relu(z2);
  const logits = layerForward(a2, layers[2]);
  const probabilities = logits.map(sigmoid);

  return {
    input,
    z1,
    a1,
    z2,
    a2,
    logits,
    probabilities,
  };
}

function binaryCrossEntropy(probabilities, target) {
  return (
    target.reduce((sum, expected, index) => {
      const probability = clamp(probabilities[index], EPSILON, 1 - EPSILON);
      return (
        sum -
        expected * Math.log(probability) -
        (1 - expected) * Math.log(1 - probability)
      );
    }, 0) / Math.max(target.length, 1)
  );
}

function createZeroGradients(layers) {
  return layers.map(cloneLayerShape);
}

function addOuterProduct(gradientLayer, delta, activation) {
  for (let row = 0; row < delta.length; row += 1) {
    gradientLayer.bias[row] += delta[row];
    for (let column = 0; column < activation.length; column += 1) {
      gradientLayer.weights[row][column] += delta[row] * activation[column];
    }
  }
}

function multiplyTranspose(layer, delta) {
  const result = createVector(layer.weights[0].length, 0);
  for (let row = 0; row < layer.weights.length; row += 1) {
    for (let column = 0; column < layer.weights[row].length; column += 1) {
      result[column] += layer.weights[row][column] * delta[row];
    }
  }
  return result;
}

function backpropagate(cache, target, layers, gradients) {
  const delta3 = cache.probabilities.map(
    (probability, index) => probability - target[index],
  );
  addOuterProduct(gradients[2], delta3, cache.a2);

  const delta2Raw = multiplyTranspose(layers[2], delta3);
  const delta2Derivative = reluDerivative(cache.z2);
  const delta2 = delta2Raw.map(
    (value, index) => value * delta2Derivative[index],
  );
  addOuterProduct(gradients[1], delta2, cache.a1);

  const delta1Raw = multiplyTranspose(layers[1], delta2);
  const delta1Derivative = reluDerivative(cache.z1);
  const delta1 = delta1Raw.map(
    (value, index) => value * delta1Derivative[index],
  );
  addOuterProduct(gradients[0], delta1, cache.input);
}

function applyAdam(layers, gradients, adam, learningRate, batchSize) {
  const beta1 = 0.9;
  const beta2 = 0.999;
  adam.t += 1;

  layers.forEach((layer, layerIndex) => {
    for (let row = 0; row < layer.weights.length; row += 1) {
      for (let column = 0; column < layer.weights[row].length; column += 1) {
        const gradient =
          gradients[layerIndex].weights[row][column] / Math.max(batchSize, 1);
        adam.m[layerIndex].weights[row][column] =
          beta1 * adam.m[layerIndex].weights[row][column] + (1 - beta1) * gradient;
        adam.v[layerIndex].weights[row][column] =
          beta2 * adam.v[layerIndex].weights[row][column] +
          (1 - beta2) * gradient * gradient;

        const mHat =
          adam.m[layerIndex].weights[row][column] / (1 - beta1 ** adam.t);
        const vHat =
          adam.v[layerIndex].weights[row][column] / (1 - beta2 ** adam.t);
        layer.weights[row][column] -=
          (learningRate * mHat) / (Math.sqrt(vHat) + EPSILON);
      }
    }

    for (let index = 0; index < layer.bias.length; index += 1) {
      const gradient =
        gradients[layerIndex].bias[index] / Math.max(batchSize, 1);
      adam.m[layerIndex].bias[index] =
        beta1 * adam.m[layerIndex].bias[index] + (1 - beta1) * gradient;
      adam.v[layerIndex].bias[index] =
        beta2 * adam.v[layerIndex].bias[index] +
        (1 - beta2) * gradient * gradient;

      const mHat = adam.m[layerIndex].bias[index] / (1 - beta1 ** adam.t);
      const vHat = adam.v[layerIndex].bias[index] / (1 - beta2 ** adam.t);
      layer.bias[index] -= (learningRate * mHat) / (Math.sqrt(vHat) + EPSILON);
    }
  });
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
  }
  return result;
}

function groupSamplesByCapture(samples) {
  const groups = new Map();

  samples.forEach((sample) => {
    const groupId = sample.captureSessionId || sample.id;
    if (!groups.has(groupId)) {
      groups.set(groupId, []);
    }
    groups.get(groupId).push(sample);
  });

  return Array.from(groups.values());
}

function splitDataset(dataset, validationSplit) {
  const train = [];
  const validation = [];

  LABEL_IDS.forEach((labelId) => {
    const labelSamples = dataset.filter((sample) => sample.label === labelId);
    const labelGroups = shuffle(groupSamplesByCapture(labelSamples));
    const validationGroupCount =
      labelSamples.length >= 5 && labelGroups.length >= 2
        ? Math.max(1, Math.round(labelGroups.length * validationSplit))
        : 0;
    const validationGroups = labelGroups.slice(0, validationGroupCount);
    const trainGroups = labelGroups.slice(validationGroupCount);

    validation.push(...validationGroups.flat());
    train.push(...trainGroups.flat());
  });

  return {
    train: shuffle(train.length ? train : dataset),
    validation: validation.length ? shuffle(validation) : shuffle(dataset),
  };
}

function getRuntimeOptions(options = {}) {
  return {
    keyOnThreshold: clamp(
      Number(options.keyOnThreshold ?? DEFAULT_KEY_ON_THRESHOLD),
      0,
      1,
    ),
    keyOffThreshold: clamp(
      Number(options.keyOffThreshold ?? DEFAULT_KEY_OFF_THRESHOLD),
      0,
      1,
    ),
    maxActiveKeys: Math.max(
      1,
      Math.min(4, Math.round(Number(options.maxActiveKeys ?? DEFAULT_MAX_ACTIVE_KEYS))),
    ),
    comboSteerThreshold: clamp(
      Number(options.comboSteerThreshold ?? DEFAULT_COMBO_STEER_THRESHOLD),
      0,
      1,
    ),
    comboSteerMargin: clamp(
      Number(options.comboSteerMargin ?? DEFAULT_COMBO_STEER_MARGIN),
      0,
      1,
    ),
  };
}

function countBits(mask) {
  let count = 0;
  let value = mask;
  while (value) {
    count += value & 1;
    value >>= 1;
  }
  return count;
}

function keepOnlyHigher(mask, keyA, keyB, probabilities) {
  const bitA = KEY_BITS[keyA];
  const bitB = KEY_BITS[keyB];
  if ((mask & bitA) && (mask & bitB)) {
    return probabilities[OUTPUT_KEY_IDS.indexOf(keyA)] >=
      probabilities[OUTPUT_KEY_IDS.indexOf(keyB)]
      ? mask & ~bitB
      : mask & ~bitA;
  }
  return mask;
}

function limitActiveKeys(mask, probabilities, maxActiveKeys) {
  if (countBits(mask) <= maxActiveKeys) {
    return mask;
  }

  const ranked = OUTPUT_KEY_IDS.map((key, index) => ({
    key,
    bit: KEY_BITS[key],
    value: probabilities[index],
  }))
    .filter((item) => mask & item.bit)
    .sort((a, b) => b.value - a.value)
    .slice(0, maxActiveKeys);

  return ranked.reduce((result, item) => result | item.bit, 0);
}

function resolveKeyMask(probabilities, options = {}) {
  const runtime = getRuntimeOptions(options);
  let mainMask = 0;

  OUTPUT_KEY_IDS.forEach((key, index) => {
    if ((Number(probabilities[index]) || 0) >= runtime.keyOnThreshold) {
      mainMask |= KEY_BITS[key];
    }
  });

  mainMask = keepOnlyHigher(mainMask, "W", "S", probabilities);
  mainMask = keepOnlyHigher(mainMask, "A", "D", probabilities);

  let mask = mainMask;
  if (mainMask & KEY_BITS.S) {
    mask = KEY_BITS.S;
  } else if (mainMask & KEY_BITS.W) {
    const aProbability = probabilities[OUTPUT_KEY_IDS.indexOf("A")];
    const dProbability = probabilities[OUTPUT_KEY_IDS.indexOf("D")];
    const aEligible =
      aProbability >= runtime.comboSteerThreshold &&
      aProbability - dProbability >= runtime.comboSteerMargin;
    const dEligible =
      dProbability >= runtime.comboSteerThreshold &&
      dProbability - aProbability >= runtime.comboSteerMargin;

    mask = KEY_BITS.W;
    if (aEligible || dEligible) {
      mask |= aEligible ? KEY_BITS.A : KEY_BITS.D;
    }
  } else if ((mainMask & KEY_BITS.A) && (mainMask & KEY_BITS.D)) {
    mask = probabilities[OUTPUT_KEY_IDS.indexOf("A")] >=
      probabilities[OUTPUT_KEY_IDS.indexOf("D")]
      ? KEY_BITS.A
      : KEY_BITS.D;
  }

  return limitActiveKeys(mask, probabilities, runtime.maxActiveKeys);
}

function keyMaskToKeys(mask) {
  return {
    w: Boolean(mask & KEY_BITS.W),
    a: Boolean(mask & KEY_BITS.A),
    s: Boolean(mask & KEY_BITS.S),
    d: Boolean(mask & KEY_BITS.D),
  };
}

function keyMaskToLabel(mask) {
  if ((mask & KEY_BITS.W) && (mask & KEY_BITS.A)) {
    return "WA";
  }
  if ((mask & KEY_BITS.W) && (mask & KEY_BITS.D)) {
    return "WD";
  }
  if (mask & KEY_BITS.W) {
    return "W";
  }
  if (mask & KEY_BITS.A) {
    return "A";
  }
  if (mask & KEY_BITS.S) {
    return "S";
  }
  if (mask & KEY_BITS.D) {
    return "D";
  }
  return "NEUTRAL";
}

function confidenceFromMask(mask, probabilities) {
  if (!mask) {
    return 1 - Math.max(...probabilities);
  }

  const activeValues = OUTPUT_KEY_IDS.map((key, index) => ({
    bit: KEY_BITS[key],
    value: probabilities[index],
  }))
    .filter((item) => mask & item.bit)
    .map((item) => item.value);

  return Math.min(...activeValues);
}

function resolvePrediction(probabilities, options = {}) {
  const keyMask = resolveKeyMask(probabilities, options);
  const confidence = clamp(confidenceFromMask(keyMask, probabilities), 0, 1);

  return {
    label: keyMaskToLabel(keyMask),
    keyMask,
    keys: keyMaskToKeys(keyMask),
    confidence,
  };
}

function evaluate(dataset, layers, options) {
  let loss = 0;
  let correct = 0;

  dataset.forEach((sample) => {
    const target = labelToTarget(sample.label);
    const output = forward(sample.x, layers);
    const prediction = resolvePrediction(output.probabilities, options);
    loss += binaryCrossEntropy(output.probabilities, target);
    if (prediction.label === sample.label) {
      correct += 1;
    }
  });

  return {
    loss: loss / Math.max(dataset.length, 1),
    accuracy: correct / Math.max(dataset.length, 1),
  };
}

function createConfusionMatrix(dataset, layers, options) {
  const matrix = LABEL_IDS.map(() => createVector(CONFUSION_LABEL_IDS.length, 0));

  dataset.forEach((sample) => {
    const output = forward(sample.x, layers);
    const prediction = resolvePrediction(output.probabilities, options);
    const actual = LABEL_IDS.indexOf(sample.label);
    const predicted = CONFUSION_LABEL_IDS.indexOf(prediction.label);
    if (actual >= 0 && predicted >= 0) {
      matrix[actual][predicted] += 1;
    }
  });

  return matrix;
}

export async function trainMlpClassifier(dataset, options = {}, onProgress = null) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const runtimeOptions = getRuntimeOptions(config);

  if (dataset.length < LABEL_IDS.length) {
    throw new Error("Collect at least one sample for every label before training.");
  }

  const missingLabels = LABEL_IDS.filter(
    (labelId) => !dataset.some((sample) => sample.label === labelId),
  );
  if (missingLabels.length) {
    throw new Error(`Missing samples for: ${missingLabels.join(", ")}`);
  }

  const standardizer = createStandardizer(dataset);
  const normalizedDataset = dataset.map((sample) => ({
    ...sample,
    x: standardizeFeature(sample.features, standardizer),
  }));
  const { train, validation } = splitDataset(
    normalizedDataset,
    config.validationSplit,
  );
  const inputSize = dataset[0].features.length;
  const layers = [
    createLayer(inputSize, 32),
    createLayer(32, 16),
    createLayer(16, OUTPUT_KEY_IDS.length),
  ];
  const adam = createAdamState(layers);
  let bestValidationLoss = Number.POSITIVE_INFINITY;
  let bestLayers = JSON.parse(JSON.stringify(layers));
  let staleEpochs = 0;
  const history = [];

  for (let epoch = 1; epoch <= config.epochs; epoch += 1) {
    const shuffledTrain = shuffle(train);

    for (let start = 0; start < shuffledTrain.length; start += config.batchSize) {
      const batch = shuffledTrain.slice(start, start + config.batchSize);
      const gradients = createZeroGradients(layers);

      batch.forEach((sample) => {
        const target = labelToTarget(sample.label);
        const cache = forward(sample.x, layers);
        backpropagate(cache, target, layers, gradients);
      });

      applyAdam(layers, gradients, adam, config.learningRate, batch.length);
    }

    const trainMetrics = evaluate(train, layers, runtimeOptions);
    const validationMetrics = evaluate(validation, layers, runtimeOptions);
    const snapshot = {
      epoch,
      trainLoss: trainMetrics.loss,
      trainAccuracy: trainMetrics.accuracy,
      validationLoss: validationMetrics.loss,
      validationAccuracy: validationMetrics.accuracy,
    };
    history.push(snapshot);

    if (validationMetrics.loss < bestValidationLoss - 0.0005) {
      bestValidationLoss = validationMetrics.loss;
      bestLayers = JSON.parse(JSON.stringify(layers));
      staleEpochs = 0;
    } else {
      staleEpochs += 1;
    }

    if (onProgress && (epoch === 1 || epoch % 5 === 0 || staleEpochs >= config.patience)) {
      onProgress(snapshot);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (staleEpochs >= config.patience) {
      break;
    }
  }

  const finalTrainMetrics = evaluate(train, bestLayers, runtimeOptions);
  const finalValidationMetrics = evaluate(validation, bestLayers, runtimeOptions);

  return {
    type: "imu-intent-mlp",
    version: 2,
    task: "wasd-multilabel",
    featureVersion: FEATURE_VERSION,
    labels: LABEL_IDS,
    outputKeys: OUTPUT_KEY_IDS,
    featureNames: FEATURE_NAMES,
    standardizer,
    layers: bestLayers,
    createdAt: new Date().toISOString(),
    runtime: {
      keyOnThreshold: runtimeOptions.keyOnThreshold,
      keyOffThreshold: runtimeOptions.keyOffThreshold,
      maxActiveKeys: runtimeOptions.maxActiveKeys,
    },
    metrics: {
      train: finalTrainMetrics,
      validation: finalValidationMetrics,
      confusionLabels: CONFUSION_LABEL_IDS,
      confusionMatrix: createConfusionMatrix(validation, bestLayers, runtimeOptions),
    },
    training: {
      options: config,
      sampleCount: dataset.length,
      history,
    },
  };
}

export function predictWithMlp(model, features, options = {}) {
  if (!model?.layers?.length || !features?.length) {
    return null;
  }

  const runtimeOptions = getRuntimeOptions({
    ...(model.runtime || {}),
    ...options,
  });
  const x = standardizeFeature(features, model.standardizer);
  const output = forward(x, model.layers);
  const prediction = resolvePrediction(output.probabilities, runtimeOptions);
  const outputs = OUTPUT_KEY_IDS.map((key, index) => ({
    key,
    label: key,
    value: output.probabilities[index],
  }));

  return {
    ...prediction,
    outputs,
    probabilities: outputs,
    runtime: runtimeOptions,
  };
}
