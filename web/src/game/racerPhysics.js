export const ROAD = Object.freeze({
  maxLane: 1.35,
  safeLane: 0.92,
  maxForwardSpeed: 285,
  maxReverseSpeed: 42,
});

const FORWARD_ACCEL = 155;
const REVERSE_ACCEL = 115;
const BRAKE_DECEL = 215;
const COAST_DECEL = 38;
const AERO_DRAG = 0.18;
const STEER_RATE = 1.85;
const CURVE_PULL = 0.34;
const OFFROAD_DRAG = 1.05;
const DISTANCE_SCALE = 8.4;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function approachZero(value, amount) {
  if (Math.abs(value) <= amount) {
    return 0;
  }

  return value > 0 ? value - amount : value + amount;
}

export function getRoadCurve(distance) {
  return (
    Math.sin(distance * 0.00115) * 0.42 +
    Math.sin(distance * 0.00042 + 1.7) * 0.24 +
    Math.sin(distance * 0.0021 + 4.2) * 0.08
  );
}

function calculateGear(speed) {
  if (speed < -2) {
    return "R";
  }
  if (speed < 10) {
    return "N";
  }
  if (speed < 54) {
    return "1";
  }
  if (speed < 98) {
    return "2";
  }
  if (speed < 146) {
    return "3";
  }
  if (speed < 196) {
    return "4";
  }
  return "5";
}

export function createInitialCarState() {
  return {
    distance: 0,
    lane: 0,
    speed: 0,
    rpm: 0,
    gear: "N",
    roadCurve: getRoadCurve(0),
    offroad: 0,
    slip: 0,
    collisionFlash: 0,
  };
}

export function updateCarState(previousState, controls, dtSeconds) {
  const dt = clamp(dtSeconds, 0.001, 0.033);
  const nextState = { ...previousState };
  const throttle = clamp(controls?.throttle || 0, 0, 1);
  const reverse = clamp(controls?.reverse || 0, 0, 1);
  const steer = clamp(controls?.steer || 0, -1, 1);

  if (throttle > 0) {
    nextState.speed += throttle * FORWARD_ACCEL * dt;
  }

  if (reverse > 0) {
    if (nextState.speed > 10) {
      nextState.speed -= reverse * BRAKE_DECEL * dt;
    } else {
      nextState.speed -= reverse * REVERSE_ACCEL * dt;
    }
  }

  if (throttle === 0 && reverse === 0) {
    nextState.speed = approachZero(nextState.speed, COAST_DECEL * dt);
  }

  const speedRatio = clamp(Math.abs(nextState.speed) / ROAD.maxForwardSpeed, 0, 1);
  nextState.speed *= Math.max(0, 1 - AERO_DRAG * speedRatio * dt);
  nextState.speed = clamp(
    nextState.speed,
    -ROAD.maxReverseSpeed,
    ROAD.maxForwardSpeed,
  );

  const previousCurve = getRoadCurve(nextState.distance);
  nextState.distance += nextState.speed * DISTANCE_SCALE * dt;
  nextState.roadCurve = getRoadCurve(nextState.distance);
  const curveDelta = nextState.roadCurve - previousCurve;

  const steeringAuthority = 0.34 + speedRatio * 1.42;
  nextState.lane += steer * steeringAuthority * dt;
  nextState.lane -= curveDelta * CURVE_PULL * speedRatio;

  const offroad = clamp(
    (Math.abs(nextState.lane) - ROAD.safeLane) / (ROAD.maxLane - ROAD.safeLane),
    0,
    1,
  );
  nextState.offroad = offroad;

  if (offroad > 0) {
    nextState.speed *= Math.max(0, 1 - OFFROAD_DRAG * offroad * dt);
    nextState.collisionFlash = Math.max(nextState.collisionFlash, offroad * 0.18);
  } else {
    nextState.collisionFlash = Math.max(0, nextState.collisionFlash - dt);
  }

  nextState.lane = clamp(nextState.lane, -ROAD.maxLane, ROAD.maxLane);
  nextState.slip = clamp(Math.abs(steer) * speedRatio + offroad * 0.7, 0, 1);
  nextState.rpm = clamp(0.14 + speedRatio * 0.74 + throttle * 0.18, 0, 1);
  nextState.gear = calculateGear(nextState.speed);

  return nextState;
}
