function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function applyCurve(value, exponent) {
  if (value <= 0) {
    return 0;
  }
  return Math.pow(clamp(value, 0, 1), exponent);
}

function getAxisStd(sample, axis) {
  return sample?.stats?.[axis]?.std || 0;
}

function getDynamicDeadZone(calibrationResults, axis, fallbackDegrees) {
  const neutralStd = getAxisStd(calibrationResults?.neutral, axis);
  return Math.max(fallbackDegrees, neutralStd * 2.6);
}

const KEY_PRESS_THRESHOLD = 0.38;
const KEY_OPPOSITE_MARGIN = 0.1;

function projectTowardTarget(value, center, target, deadZoneDegrees, exponent) {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(center) ||
    !Number.isFinite(target)
  ) {
    return 0;
  }

  const travel = target - center;
  const delta = value - center;
  if (Math.abs(travel) < 0.001 || Math.abs(delta) < deadZoneDegrees) {
    return 0;
  }

  return applyCurve(clamp(delta / travel, 0, 1), exponent);
}

function resolveKeyPair(negativeAmount, positiveAmount, negativeKey, positiveKey) {
  const result = {
    [negativeKey]: false,
    [positiveKey]: false,
  };

  const negativeActive = negativeAmount >= KEY_PRESS_THRESHOLD;
  const positiveActive = positiveAmount >= KEY_PRESS_THRESHOLD;

  if (negativeActive && positiveActive) {
    if (Math.abs(negativeAmount - positiveAmount) < KEY_OPPOSITE_MARGIN) {
      return result;
    }

    result[negativeAmount > positiveAmount ? negativeKey : positiveKey] = true;
    return result;
  }

  result[negativeKey] = negativeActive;
  result[positiveKey] = positiveActive;
  return result;
}

function createVirtualKeys(directionAmounts) {
  const pitchKeys = resolveKeyPair(
    directionAmounts.backward,
    directionAmounts.forward,
    "s",
    "w",
  );
  const rollKeys = resolveKeyPair(
    directionAmounts.left,
    directionAmounts.right,
    "a",
    "d",
  );
  const keys = {
    w: pitchKeys.w,
    a: rollKeys.a,
    s: pitchKeys.s,
    d: rollKeys.d,
  };
  const combo = ["w", "a", "s", "d"]
    .filter((key) => keys[key])
    .join("")
    .toUpperCase();

  return {
    ...keys,
    combo: combo || "NONE",
    forwardDiagonal: keys.w && (keys.a || keys.d),
    threshold: KEY_PRESS_THRESHOLD,
  };
}

export function hasCalibrationProfile(results) {
  return Boolean(
    results?.neutral &&
      results?.left &&
      results?.right &&
      results?.forward &&
      results?.backward,
  );
}

export function mapPoseToControls(currentPose, calibrationResults) {
  if (!hasCalibrationProfile(calibrationResults)) {
    return {
      steer: 0,
      throttle: 0,
      reverse: 0,
      pitchAxis: 0,
      rollAxis: 0,
      directionAmounts: {
        left: 0,
        right: 0,
        forward: 0,
        backward: 0,
      },
      virtualKeys: createVirtualKeys({
        left: 0,
        right: 0,
        forward: 0,
        backward: 0,
      }),
    };
  }

  const rollDeadZone = getDynamicDeadZone(calibrationResults, "roll", 1.8);
  const pitchDeadZone = getDynamicDeadZone(calibrationResults, "pitch", 2.2);
  const leftAmount = projectTowardTarget(
    currentPose.roll,
    calibrationResults.neutral.roll,
    calibrationResults.left.roll,
    rollDeadZone,
    1.35,
  );
  const rightAmount = projectTowardTarget(
    currentPose.roll,
    calibrationResults.neutral.roll,
    calibrationResults.right.roll,
    rollDeadZone,
    1.35,
  );
  const forwardAmount = projectTowardTarget(
    currentPose.pitch,
    calibrationResults.neutral.pitch,
    calibrationResults.forward.pitch,
    pitchDeadZone,
    1.5,
  );
  const backwardAmount = projectTowardTarget(
    currentPose.pitch,
    calibrationResults.neutral.pitch,
    calibrationResults.backward.pitch,
    pitchDeadZone,
    1.35,
  );

  const rollAxis = clamp(rightAmount - leftAmount, -1, 1);
  const pitchAxis = clamp(backwardAmount - forwardAmount, -1, 1);
  const directionAmounts = {
    left: leftAmount,
    right: rightAmount,
    forward: forwardAmount,
    backward: backwardAmount,
  };

  return {
    steer: clamp(rollAxis * 1.12, -1, 1),
    throttle: clamp(forwardAmount, 0, 1),
    reverse: clamp(backwardAmount * 0.88, 0, 1),
    pitchAxis,
    rollAxis,
    directionAmounts,
    virtualKeys: createVirtualKeys(directionAmounts),
    deadZones: {
      pitch: pitchDeadZone,
      roll: rollDeadZone,
    },
  };
}

export function smoothControls(previousControls, nextControls) {
  const largestChange = Math.max(
    Math.abs(nextControls.steer - previousControls.steer),
    Math.abs(nextControls.throttle - previousControls.throttle),
    Math.abs(nextControls.reverse - previousControls.reverse),
  );
  const alpha = largestChange > 0.22 ? 0.34 : 0.14;
  const blend = (previousValue, nextValue) =>
    previousValue + (nextValue - previousValue) * alpha;
  const previousAmounts = previousControls.directionAmounts || {
    left: 0,
    right: 0,
    forward: 0,
    backward: 0,
  };
  const nextAmounts = nextControls.directionAmounts || previousAmounts;
  const directionAmounts = {
    left: blend(previousAmounts.left, nextAmounts.left),
    right: blend(previousAmounts.right, nextAmounts.right),
    forward: blend(previousAmounts.forward, nextAmounts.forward),
    backward: blend(previousAmounts.backward, nextAmounts.backward),
  };

  return {
    steer: blend(previousControls.steer, nextControls.steer),
    throttle: blend(previousControls.throttle, nextControls.throttle),
    reverse: blend(previousControls.reverse, nextControls.reverse),
    pitchAxis: blend(previousControls.pitchAxis, nextControls.pitchAxis),
    rollAxis: blend(previousControls.rollAxis, nextControls.rollAxis),
    directionAmounts,
    virtualKeys: createVirtualKeys(directionAmounts),
    deadZones: nextControls.deadZones,
  };
}
