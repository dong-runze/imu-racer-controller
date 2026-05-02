<script>
  import { createEventDispatcher, onDestroy, onMount } from "svelte";

  import {
    createInitialCarState,
    ROAD,
    updateCarState,
  } from "../game/racerPhysics";

  export let controls = {
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
    virtualKeys: {
      w: false,
      a: false,
      s: false,
      d: false,
      combo: "NONE",
    },
  };
  export let pose = { pitch: 0, roll: 0, yaw: 0 };
  export let calibrationResults = {};

  const dispatch = createEventDispatcher();
  const laneMarkers = Array.from({ length: 12 }, (_, index) => index);
  const roadsidePosts = Array.from({ length: 16 }, (_, index) => ({
    index,
    side: index % 2 === 0 ? "left" : "right",
  }));
  const trafficCars = [
    { lane: -0.42, offset: 0.1, color: "#ffbb5c" },
    { lane: 0.48, offset: 0.46, color: "#6dc7ff" },
    { lane: 0.08, offset: 0.76, color: "#ff6a88" },
  ];
  const emptyDirectionAmounts = {
    left: 0,
    right: 0,
    forward: 0,
    backward: 0,
  };

  let car = createInitialCarState();
  let frameHandle = 0;
  let lastFrameMs = 0;
  let keyboardKeys = {
    w: false,
    a: false,
    s: false,
    d: false,
  };
  let keyboardControls = createKeyboardControls(keyboardKeys);
  let driveControls = mergeDriveControls(controls, keyboardControls);

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function positiveModulo(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
  }

  function formatSigned(value) {
    return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
  }

  function formatAngle(value) {
    return `${value >= 0 ? "+" : ""}${value.toFixed(1)} deg`;
  }

  function formatSpeed(value) {
    return Math.max(0, Math.round(value)).toString().padStart(3, "0");
  }

  function keyCombo(keys) {
    const combo = ["w", "a", "s", "d"]
      .filter((key) => keys?.[key])
      .join("")
      .toUpperCase();

    return combo || "NONE";
  }

  function hasKeyInput(keys) {
    return Boolean(keys?.w || keys?.a || keys?.s || keys?.d);
  }

  function normalizeKeyboardKey(event) {
    const key = event.key.toLowerCase();
    if (key === "arrowup") {
      return "w";
    }
    if (key === "arrowleft") {
      return "a";
    }
    if (key === "arrowdown") {
      return "s";
    }
    if (key === "arrowright") {
      return "d";
    }
    if (["w", "a", "s", "d"].includes(key)) {
      return key;
    }
    return "";
  }

  function updateKeyboardKey(key, pressed) {
    if (!key) {
      return;
    }

    keyboardKeys = {
      ...keyboardKeys,
      [key]: pressed,
    };
  }

  function handleKeyDown(event) {
    const key = normalizeKeyboardKey(event);
    if (!key) {
      return;
    }

    event.preventDefault();
    updateKeyboardKey(key, true);
  }

  function handleKeyUp(event) {
    const key = normalizeKeyboardKey(event);
    if (!key) {
      return;
    }

    event.preventDefault();
    updateKeyboardKey(key, false);
  }

  function clearKeyboard() {
    keyboardKeys = {
      w: false,
      a: false,
      s: false,
      d: false,
    };
  }

  function createKeyboardControls(keys) {
    const left = keys.a && !keys.d;
    const right = keys.d && !keys.a;
    const forward = keys.w && !keys.s;
    const backward = keys.s && !keys.w;
    const virtualKeys = {
      w: forward,
      a: left,
      s: backward,
      d: right,
    };

    return {
      steer: left ? -1 : right ? 1 : 0,
      throttle: forward ? 1 : 0,
      reverse: backward ? 1 : 0,
      pitchAxis: backward ? 1 : forward ? -1 : 0,
      rollAxis: left ? -1 : right ? 1 : 0,
      directionAmounts: {
        left: left ? 1 : 0,
        right: right ? 1 : 0,
        forward: forward ? 1 : 0,
        backward: backward ? 1 : 0,
      },
      virtualKeys: {
        ...virtualKeys,
        combo: keyCombo(virtualKeys),
        forwardDiagonal: forward && (left || right),
      },
    };
  }

  function mergeDriveControls(imuControls, keyControls) {
    const imu = imuControls || {};
    const keyboardActive = hasKeyInput(keyControls.virtualKeys);
    const keyboardSteerActive = keyControls.virtualKeys.a || keyControls.virtualKeys.d;
    const keyboardDriveActive = keyControls.virtualKeys.w || keyControls.virtualKeys.s;
    const imuKeys = imu.virtualKeys || {};
    const imuMode = imu.inputMode || "IMU";
    const mergedKeys = {
      w: keyControls.virtualKeys.w || imuKeys.w,
      a: keyControls.virtualKeys.a || imuKeys.a,
      s: keyControls.virtualKeys.s || imuKeys.s,
      d: keyControls.virtualKeys.d || imuKeys.d,
    };
    const directionAmounts = imu.directionAmounts || emptyDirectionAmounts;

    return {
      steer: keyboardSteerActive ? keyControls.steer : imu.steer || 0,
      throttle: keyboardDriveActive ? keyControls.throttle : imu.throttle || 0,
      reverse: keyboardDriveActive ? keyControls.reverse : imu.reverse || 0,
      pitchAxis: keyboardDriveActive ? keyControls.pitchAxis : imu.pitchAxis || 0,
      rollAxis: keyboardSteerActive ? keyControls.rollAxis : imu.rollAxis || 0,
      directionAmounts: {
        left: keyboardSteerActive ? keyControls.directionAmounts.left : directionAmounts.left,
        right: keyboardSteerActive ? keyControls.directionAmounts.right : directionAmounts.right,
        forward: keyboardDriveActive
          ? keyControls.directionAmounts.forward
          : directionAmounts.forward,
        backward: keyboardDriveActive
          ? keyControls.directionAmounts.backward
          : directionAmounts.backward,
      },
      virtualKeys: {
        ...mergedKeys,
        combo: keyCombo(mergedKeys),
        forwardDiagonal: mergedKeys.w && (mergedKeys.a || mergedKeys.d),
      },
      inputMode: keyboardActive
        ? hasKeyInput(imuKeys)
          ? `Keyboard + ${imuMode}`
          : "Keyboard"
        : imuMode,
    };
  }

  function describeCombo(keys) {
    if (keys?.w && keys?.a) {
      return "W + A: forward-left";
    }
    if (keys?.w && keys?.d) {
      return "W + D: forward-right";
    }
    if (keys?.w) {
      return "W: accelerate";
    }
    if (keys?.s) {
      return "S: brake / reverse";
    }
    if (keys?.a) {
      return "A: steer left";
    }
    if (keys?.d) {
      return "D: steer right";
    }
    return "Neutral: no drive input";
  }

  function laneMarkerStyle(index, laneOffset) {
    const depth = positiveModulo(index / laneMarkers.length + car.distance / 940, 1);
    const bottom = 86 - depth * 78;
    const scale = 0.22 + depth * 1.35;
    const opacity = clamp(depth * 1.55, 0.12, 0.92);
    const curveShift = car.roadCurve * (1 - depth) * 180;
    const carShift = -car.lane * depth * 86;
    const x = laneOffset * depth * 285 + curveShift + carShift;

    return [
      `left:${50 + laneOffset * 15}%`,
      `bottom:${bottom.toFixed(2)}%`,
      `width:${(5 + depth * 13).toFixed(1)}px`,
      `height:${(24 + depth * 72).toFixed(1)}px`,
      `opacity:${opacity.toFixed(3)}`,
      `transform:translateX(${x.toFixed(1)}px) scale(${scale.toFixed(3)})`,
    ].join(";");
  }

  function roadsidePostStyle(post) {
    const depth = positiveModulo(post.index / roadsidePosts.length + car.distance / 760, 1);
    const bottom = 82 - depth * 70;
    const scale = 0.22 + depth * 1.55;
    const side = post.side === "left" ? -1 : 1;
    const curveShift = car.roadCurve * (1 - depth) * 120;
    const carShift = -car.lane * depth * 98;
    const x = side * (140 + depth * 430) + curveShift + carShift;
    const opacity = clamp(depth * 1.4, 0.16, 0.86);

    return [
      `left:50%`,
      `bottom:${bottom.toFixed(2)}%`,
      `opacity:${opacity.toFixed(3)}`,
      `transform:translateX(${x.toFixed(1)}px) scale(${scale.toFixed(3)})`,
    ].join(";");
  }

  function trafficCarStyle(rival) {
    const depth = positiveModulo(rival.offset + car.distance / 1850, 1);
    const bottom = 76 - depth * 55;
    const scale = 0.18 + depth * 0.86;
    const curveShift = car.roadCurve * (1 - depth) * 150;
    const carShift = -car.lane * depth * 110;
    const x = rival.lane * depth * 310 + curveShift + carShift;
    const opacity = clamp(depth * 1.6, 0, 0.94);

    return [
      `left:50%`,
      `bottom:${bottom.toFixed(2)}%`,
      `opacity:${opacity.toFixed(3)}`,
      `transform:translateX(${x.toFixed(1)}px) scale(${scale.toFixed(3)})`,
      `--rival-color:${rival.color}`,
    ].join(";");
  }

  function speedLineStyle(index) {
    const left = ((index * 17) % 136) - 18;
    const top = ((index * 11) % 118) - 16;
    const height = 70 + speedRatio * 150;

    return [
      `left:${left}%`,
      `top:${top}%`,
      `height:${height.toFixed(1)}px`,
    ].join(";");
  }

  function resetRun() {
    car = createInitialCarState();
  }

  function leaveDriveMode() {
    clearKeyboard();
    dispatch("back");
  }

  function tick(frameMs) {
    if (!lastFrameMs) {
      lastFrameMs = frameMs;
    }

    const dtSeconds = (frameMs - lastFrameMs) / 1000;
    lastFrameMs = frameMs;
    car = updateCarState(car, driveControls, dtSeconds);
    frameHandle = requestAnimationFrame(tick);
  }

  $: keyboardControls = createKeyboardControls(keyboardKeys);
  $: driveControls = mergeDriveControls(controls, keyboardControls);
  $: speedRatio = clamp(Math.max(car.speed, 0) / ROAD.maxForwardSpeed, 0, 1);
  $: screenStyle = [
    `--speed-ratio:${speedRatio.toFixed(3)}`,
    `--curve-shift:${(car.roadCurve * 82 - car.lane * 34).toFixed(1)}px`,
    `--car-x:${(car.lane * 160).toFixed(1)}px`,
    `--car-tilt:${(driveControls.steer * 8 + car.slip * driveControls.steer * 6).toFixed(1)}deg`,
    `--road-skew:${(speedRatio * -2).toFixed(2)}deg`,
    `--screen-shake:${(car.collisionFlash * 10).toFixed(1)}px`,
  ].join(";");

  onMount(() => {
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearKeyboard);
    frameHandle = requestAnimationFrame(tick);
  });

  onDestroy(() => {
    if (frameHandle) {
      cancelAnimationFrame(frameHandle);
    }
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("keyup", handleKeyUp);
    window.removeEventListener("blur", clearKeyboard);
  });
</script>

<section class="drive-layout">
  <article class="drive-card playfield-card">
    <div class="playfield-head">
      <div>
        <p class="eyebrow">Drive Mode</p>
        <h2>Night Sprint Racer</h2>
        <p class="drive-copy">
          Use the IMU or physical WASD keys. Keyboard input overrides only the
          axis you press, so you can test acceleration, steering, and diagonal
          WA / WD control immediately.
        </p>
      </div>
      <div class="head-actions">
        <button on:click={resetRun}>Reset Car</button>
        <button class="ghost" on:click={leaveDriveMode}>Back to Calibration</button>
      </div>
    </div>

    <div
      class="racing-screen"
      class:impact={car.collisionFlash > 0.08}
      class:offroad={car.offroad > 0.2}
      style={screenStyle}
    >
      <div class="sky">
        <div class="moon" />
        <div class="city-line line-a" />
        <div class="city-line line-b" />
      </div>

      <div class="speed-lines">
        {#each Array(18) as _, index}
          <span style={speedLineStyle(index)} />
        {/each}
      </div>

      <div class="road" aria-hidden="true">
        <div class="road-glow" />
      </div>

      {#each laneMarkers as marker}
        <span class="lane-marker side-left" style={laneMarkerStyle(marker, -0.34)} />
        <span class="lane-marker center" style={laneMarkerStyle(marker, 0)} />
        <span class="lane-marker side-right" style={laneMarkerStyle(marker, 0.34)} />
      {/each}

      {#each roadsidePosts as post}
        <span class="road-post {post.side}" style={roadsidePostStyle(post)}>
          <span />
        </span>
      {/each}

      {#each trafficCars as rival}
        <div class="rival-car" style={trafficCarStyle(rival)}>
          <span class="rival-window" />
          <span class="rival-light left" />
          <span class="rival-light right" />
        </div>
      {/each}

      <div class="player-car" style={`transform:translateX(calc(-50% + var(--car-x))) rotate(var(--car-tilt))`}>
        <svg viewBox="0 0 220 320" role="img" aria-label="Player car">
          <defs>
            <linearGradient id="carPaint" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0" stop-color="#7ae582" />
              <stop offset="0.45" stop-color="#37d4ff" />
              <stop offset="1" stop-color="#ffbb5c" />
            </linearGradient>
            <linearGradient id="glass" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stop-color="#c8f6ff" stop-opacity="0.9" />
              <stop offset="1" stop-color="#07151c" stop-opacity="0.95" />
            </linearGradient>
          </defs>
          <path class="car-shadow" d="M44 292 C76 310 146 310 176 292 L162 248 H58 Z" />
          <path class="rear-wing" d="M42 235 L178 235 L194 268 L26 268 Z" />
          <path class="car-shell" d="M46 260 L64 86 C68 48 88 26 110 26 C132 26 152 48 156 86 L174 260 C156 282 64 282 46 260 Z" />
          <path class="windshield" d="M78 86 C86 54 98 44 110 44 C122 44 134 54 142 86 L133 132 H87 Z" />
          <path class="hood-line" d="M76 154 L144 154 M72 204 L148 204" />
          <path class="left-wheel" d="M30 142 C20 154 20 220 32 238 L54 230 L56 150 Z" />
          <path class="right-wheel" d="M190 142 C200 154 200 220 188 238 L166 230 L164 150 Z" />
          <path class="headlight left" d="M72 252 L100 260 L92 276 L62 264 Z" />
          <path class="headlight right" d="M148 252 L120 260 L128 276 L158 264 Z" />
        </svg>
      </div>

      <div class="cockpit-hud">
        <div class="speed-stack">
          <span>Speed</span>
          <strong>{formatSpeed(car.speed)}</strong>
          <em>km/h</em>
        </div>
        <div class="gear-stack">
          <span>Gear</span>
          <strong>{car.gear}</strong>
        </div>
        <div class="input-stack">
          <span>Input</span>
          <strong>{driveControls.virtualKeys?.combo || "NONE"}</strong>
          <em>{driveControls.inputMode}</em>
        </div>
      </div>

      <div class="tachometer">
        <div class="tach-fill" style={`width:${(car.rpm * 100).toFixed(1)}%`} />
      </div>

      <div class="keyboard-strip" aria-label="WASD keyboard status">
        <kbd class:pressed={driveControls.virtualKeys?.w}>W</kbd>
        <kbd class:pressed={driveControls.virtualKeys?.a}>A</kbd>
        <kbd class:pressed={driveControls.virtualKeys?.s}>S</kbd>
        <kbd class:pressed={driveControls.virtualKeys?.d}>D</kbd>
      </div>
    </div>
  </article>

  <article class="drive-card telemetry-card">
    <h3>Control Telemetry</h3>

    <div class="keyboard-box">
      <div class="keyboard-head">
        <span>Virtual Keyboard</span>
        <strong>{driveControls.virtualKeys?.combo || "NONE"}</strong>
      </div>
      <div class="wasd-grid" aria-label="Virtual WASD keys">
        <div />
        <div class:pressed={driveControls.virtualKeys?.w}>W</div>
        <div />
        <div class:pressed={driveControls.virtualKeys?.a}>A</div>
        <div class:pressed={driveControls.virtualKeys?.s}>S</div>
        <div class:pressed={driveControls.virtualKeys?.d}>D</div>
      </div>
      <p>{describeCombo(driveControls.virtualKeys)}</p>
      <p class="keyboard-note">
        Physical keyboard: W accelerate, S brake/reverse, A/D steer.
        Arrow keys are mapped to the same actions.
      </p>
    </div>

    <div class="meter">
      <div class="meter-head">
        <span>Steer</span>
        <strong>{formatSigned(driveControls.steer)}</strong>
      </div>
      <div class="meter-track split">
        <div
          class="meter-fill steer"
          style={`left:${driveControls.steer < 0 ? `${50 + driveControls.steer * 50}%` : "50%"}; width:${Math.abs(driveControls.steer) * 50}%`}
        />
      </div>
    </div>

    <div class="meter">
      <div class="meter-head">
        <span>Throttle</span>
        <strong>{formatSigned(driveControls.throttle)}</strong>
      </div>
      <div class="meter-track">
        <div class="meter-fill throttle" style={`width:${driveControls.throttle * 100}%`} />
      </div>
    </div>

    <div class="meter">
      <div class="meter-head">
        <span>Reverse</span>
        <strong>{formatSigned(driveControls.reverse)}</strong>
      </div>
      <div class="meter-track">
        <div class="meter-fill reverse" style={`width:${driveControls.reverse * 100}%`} />
      </div>
    </div>

    <div class="stat-grid">
      <div>
        <span>Pitch</span>
        <strong>{formatAngle(pose.pitch)}</strong>
      </div>
      <div>
        <span>Roll</span>
        <strong>{formatAngle(pose.roll)}</strong>
      </div>
      <div>
        <span>Road Offset</span>
        <strong>{formatSigned(car.lane)}</strong>
      </div>
      <div>
        <span>Offroad</span>
        <strong>{Math.round(car.offroad * 100)}%</strong>
      </div>
    </div>

    <div class="calibration-box">
      <h4>Calibration Snapshot</h4>
      <p>Neutral roll: {formatAngle(calibrationResults?.neutral?.roll || 0)}</p>
      <p>Left roll: {formatAngle(calibrationResults?.left?.roll || 0)}</p>
      <p>Right roll: {formatAngle(calibrationResults?.right?.roll || 0)}</p>
      <p>Forward pitch: {formatAngle(calibrationResults?.forward?.pitch || 0)}</p>
      <p>Backward pitch: {formatAngle(calibrationResults?.backward?.pitch || 0)}</p>
    </div>
  </article>
</section>

<style lang="scss">
  .drive-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr);
    gap: 18px;
    margin-top: 28px;
  }

  .drive-card {
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(5, 10, 16, 0.58);
    backdrop-filter: blur(12px);
    border-radius: 22px;
    padding: 20px;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.24);
  }

  .playfield-head {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: start;
    margin-bottom: 18px;
  }

  .eyebrow {
    margin: 0 0 8px;
    color: #ffbb5c;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  h2,
  h3,
  h4,
  p {
    margin-top: 0;
  }

  h2 {
    margin-bottom: 12px;
  }

  .drive-copy {
    max-width: 700px;
    color: rgba(255, 255, 255, 0.68);
  }

  .head-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: flex-end;
  }

  .head-actions button {
    width: auto;
    min-width: 142px;
    padding: 0 18px;
  }

  .ghost {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.24);
  }

  .racing-screen {
    position: relative;
    min-height: 620px;
    border-radius: 24px;
    overflow: hidden;
    isolation: isolate;
    background:
      radial-gradient(circle at 50% 26%, rgba(84, 227, 255, 0.22), transparent 28%),
      linear-gradient(180deg, #07111f 0%, #0c1724 38%, #05080d 100%);
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.1),
      inset 0 -120px 160px rgba(0, 0, 0, 0.5);
    transform: translateX(var(--screen-shake));
  }

  .racing-screen::before,
  .racing-screen::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 20;
  }

  .racing-screen::before {
    background:
      linear-gradient(90deg, rgba(122, 229, 130, 0.12), transparent 18%, transparent 82%, rgba(255, 187, 92, 0.15)),
      repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.025) 0 1px, transparent 1px 4px);
    mix-blend-mode: screen;
  }

  .racing-screen::after {
    background: radial-gradient(ellipse at center, transparent 40%, rgba(0, 0, 0, 0.58) 100%);
  }

  .racing-screen.impact {
    filter: saturate(1.35) contrast(1.08);
  }

  .racing-screen.offroad .player-car {
    filter: drop-shadow(0 20px 34px rgba(255, 106, 136, 0.34));
  }

  .sky {
    position: absolute;
    inset: 0 0 42%;
    overflow: hidden;
  }

  .moon {
    position: absolute;
    top: 42px;
    right: 84px;
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: radial-gradient(circle at 34% 30%, #ffffff, #d9f7ff 42%, #6dc7ff 100%);
    opacity: 0.78;
    box-shadow: 0 0 70px rgba(109, 199, 255, 0.55);
  }

  .city-line {
    position: absolute;
    left: -8%;
    right: -8%;
    bottom: 0;
    height: 118px;
    opacity: 0.62;
    background:
      linear-gradient(90deg, transparent 0 4%, #13283b 4% 9%, transparent 9% 13%, #1a3450 13% 20%, transparent 20% 24%, #102337 24% 31%, transparent 31% 38%, #173453 38% 46%, transparent 46% 52%, #102a42 52% 61%, transparent 61% 69%, #183456 69% 82%, transparent 82% 100%);
    clip-path: polygon(0 100%, 0 48%, 6% 48%, 6% 18%, 11% 18%, 11% 62%, 18% 62%, 18% 30%, 25% 30%, 25% 68%, 35% 68%, 35% 12%, 42% 12%, 42% 55%, 50% 55%, 50% 24%, 58% 24%, 58% 72%, 66% 72%, 66% 36%, 76% 36%, 76% 60%, 84% 60%, 84% 16%, 92% 16%, 92% 100%);
  }

  .line-b {
    transform: translateX(10%) scaleY(0.7);
    opacity: 0.38;
    filter: blur(1px);
  }

  .speed-lines {
    position: absolute;
    inset: 0;
    z-index: 8;
    opacity: calc(0.08 + var(--speed-ratio) * 0.48);
  }

  .speed-lines span {
    position: absolute;
    width: 2px;
    transform: rotate(18deg);
    background: linear-gradient(180deg, transparent, rgba(255, 255, 255, 0.42), transparent);
  }

  .road {
    position: absolute;
    left: 50%;
    bottom: -16%;
    z-index: 4;
    width: 86%;
    height: 95%;
    transform-origin: 50% 100%;
    transform: translateX(calc(-50% + var(--curve-shift))) rotateX(62deg) skewX(var(--road-skew));
    background:
      linear-gradient(90deg, transparent 0%, rgba(255, 187, 92, 0.64) 3%, transparent 5%),
      linear-gradient(270deg, transparent 0%, rgba(122, 229, 130, 0.55) 3%, transparent 5%),
      linear-gradient(90deg, #05070a 0%, #161c23 19%, #252b33 50%, #151b22 81%, #05070a 100%);
    clip-path: polygon(43% 0, 57% 0, 100% 100%, 0 100%);
    box-shadow:
      inset 0 0 90px rgba(0, 0, 0, 0.62),
      0 0 80px rgba(109, 199, 255, 0.12);
  }

  .road-glow {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse at 50% 10%, rgba(109, 199, 255, 0.24), transparent 35%),
      repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.025) 0 1px, transparent 1px 48px);
  }

  .lane-marker {
    position: absolute;
    z-index: 7;
    border-radius: 999px;
    transform-origin: 50% 50%;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(109, 199, 255, 0.5));
    box-shadow: 0 0 18px rgba(109, 199, 255, 0.42);
  }

  .lane-marker.center {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(255, 187, 92, 0.6));
    box-shadow: 0 0 18px rgba(255, 187, 92, 0.44);
  }

  .road-post {
    position: absolute;
    z-index: 6;
    width: 12px;
    height: 98px;
    transform-origin: 50% 100%;
  }

  .road-post span {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(180deg, #ffbb5c, #ff6a88);
    box-shadow: 0 0 26px rgba(255, 187, 92, 0.6);
  }

  .road-post.right span {
    background: linear-gradient(180deg, #6dc7ff, #7ae582);
    box-shadow: 0 0 26px rgba(109, 199, 255, 0.58);
  }

  .rival-car {
    position: absolute;
    z-index: 9;
    width: 54px;
    height: 82px;
    margin-left: -27px;
    border-radius: 18px 18px 12px 12px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.45), transparent 18%),
      var(--rival-color);
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.42);
  }

  .rival-window {
    position: absolute;
    left: 12px;
    right: 12px;
    top: 14px;
    height: 22px;
    border-radius: 9px;
    background: rgba(4, 14, 20, 0.82);
  }

  .rival-light {
    position: absolute;
    bottom: 7px;
    width: 10px;
    height: 5px;
    border-radius: 999px;
    background: #fff8c9;
  }

  .rival-light.left {
    left: 10px;
  }

  .rival-light.right {
    right: 10px;
  }

  .player-car {
    position: absolute;
    left: 50%;
    bottom: 22px;
    z-index: 14;
    width: min(230px, 36vw);
    transform-origin: 50% 72%;
    transition: filter 120ms ease;
    filter:
      drop-shadow(0 18px 34px rgba(0, 0, 0, 0.62))
      drop-shadow(0 0 28px rgba(122, 229, 130, 0.26));
  }

  .player-car svg {
    display: block;
    width: 100%;
  }

  .car-shadow {
    fill: rgba(0, 0, 0, 0.42);
  }

  .rear-wing,
  .car-shell {
    fill: url("#carPaint");
    stroke: rgba(255, 255, 255, 0.45);
    stroke-width: 4;
  }

  .windshield {
    fill: url("#glass");
    stroke: rgba(255, 255, 255, 0.32);
    stroke-width: 3;
  }

  .hood-line {
    fill: none;
    stroke: rgba(255, 255, 255, 0.34);
    stroke-width: 4;
    stroke-linecap: round;
  }

  .left-wheel,
  .right-wheel {
    fill: #05080c;
    stroke: rgba(255, 255, 255, 0.18);
    stroke-width: 3;
  }

  .headlight {
    fill: #fff6ad;
    filter: drop-shadow(0 0 12px rgba(255, 246, 173, 0.78));
  }

  .cockpit-hud {
    position: absolute;
    z-index: 18;
    left: 22px;
    right: 22px;
    top: 20px;
    display: grid;
    grid-template-columns: minmax(128px, 0.6fr) minmax(86px, 0.3fr) minmax(160px, 0.8fr);
    gap: 12px;
    align-items: start;
  }

  .speed-stack,
  .gear-stack,
  .input-stack {
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 18px;
    padding: 13px 15px;
    background: rgba(3, 8, 13, 0.58);
    box-shadow: inset 0 0 24px rgba(109, 199, 255, 0.05);
  }

  .speed-stack span,
  .gear-stack span,
  .input-stack span,
  .speed-stack em,
  .input-stack em {
    display: block;
    color: rgba(255, 255, 255, 0.62);
    font-style: normal;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 11px;
    line-height: 1.3;
  }

  .speed-stack strong {
    display: block;
    margin: 2px 0 -2px;
    font-size: clamp(44px, 6vw, 78px);
    line-height: 0.9;
    color: #f7fbff;
    text-shadow: 0 0 28px rgba(109, 199, 255, 0.44);
  }

  .gear-stack strong,
  .input-stack strong {
    display: block;
    margin: 6px 0 0;
    font-size: 34px;
    line-height: 1;
    color: #ffbb5c;
  }

  .tachometer {
    position: absolute;
    z-index: 18;
    left: 26px;
    right: 26px;
    bottom: 22px;
    height: 10px;
    border-radius: 999px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.1);
  }

  .tach-fill {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #7ae582, #ffbb5c 70%, #ff6a88 100%);
    box-shadow: 0 0 24px rgba(255, 187, 92, 0.48);
  }

  .keyboard-strip {
    position: absolute;
    z-index: 18;
    right: 22px;
    bottom: 48px;
    display: grid;
    grid-template-columns: repeat(4, 38px);
    gap: 8px;
  }

  kbd {
    display: grid;
    place-items: center;
    min-height: 34px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.22);
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.74);
    font-family: "Google Sans Mono", "Roboto Mono", monospace;
    font-weight: 800;
  }

  kbd.pressed {
    background: linear-gradient(135deg, #7ae582, #ffbb5c);
    color: #061016;
    box-shadow: 0 0 20px rgba(122, 229, 130, 0.36);
  }

  .telemetry-card {
    display: grid;
    gap: 16px;
    align-content: start;
  }

  .meter {
    display: grid;
    gap: 8px;
  }

  .keyboard-box {
    display: grid;
    gap: 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    padding: 14px;
    background: rgba(255, 255, 255, 0.03);
  }

  .keyboard-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: rgba(255, 255, 255, 0.72);
  }

  .keyboard-head strong {
    color: #ffbb5c;
    letter-spacing: 0.08em;
  }

  .wasd-grid {
    display: grid;
    grid-template-columns: repeat(3, 52px);
    gap: 8px;
    justify-content: center;
  }

  .wasd-grid div {
    min-height: 42px;
    border-radius: 12px;
  }

  .wasd-grid div:not(:empty) {
    display: grid;
    place-items: center;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.66);
    font-weight: 800;
  }

  .wasd-grid div.pressed {
    border-color: rgba(122, 229, 130, 0.84);
    background: linear-gradient(135deg, rgba(122, 229, 130, 0.92), rgba(255, 187, 92, 0.9));
    color: #081016;
    box-shadow: 0 0 18px rgba(122, 229, 130, 0.28);
  }

  .keyboard-box p {
    margin: 0;
    color: rgba(255, 255, 255, 0.68);
    text-align: center;
  }

  .keyboard-note {
    font-size: 13px;
    line-height: 1.5;
  }

  .meter-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    color: rgba(255, 255, 255, 0.78);
  }

  .meter-track {
    position: relative;
    height: 14px;
    border-radius: 999px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.08);
  }

  .meter-track.split::before {
    content: "";
    position: absolute;
    inset: 0 auto 0 50%;
    width: 1px;
    background: rgba(255, 255, 255, 0.18);
  }

  .meter-fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
  }

  .meter-fill.steer {
    background: linear-gradient(90deg, #ffbb5c, #7ae582);
  }

  .meter-fill.throttle {
    background: linear-gradient(90deg, #6dc7ff, #7ae582);
  }

  .meter-fill.reverse {
    background: linear-gradient(90deg, #ff8d8d, #ffbb5c);
  }

  .stat-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }

  .stat-grid div,
  .calibration-box {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    padding: 14px;
    background: rgba(255, 255, 255, 0.03);
  }

  .stat-grid span,
  .calibration-box p {
    color: rgba(255, 255, 255, 0.68);
  }

  .stat-grid strong {
    display: block;
    margin-top: 6px;
    font-size: 20px;
  }

  @media (max-width: 960px) {
    .drive-layout {
      grid-template-columns: 1fr;
    }

    .playfield-head {
      flex-direction: column;
    }

    .head-actions {
      justify-content: flex-start;
    }

    .racing-screen {
      min-height: 520px;
    }

    .cockpit-hud {
      grid-template-columns: 1fr 0.6fr;
    }

    .input-stack {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 620px) {
    .racing-screen {
      min-height: 460px;
    }

    .player-car {
      width: 172px;
    }

    .keyboard-strip {
      left: 22px;
      right: auto;
      grid-template-columns: repeat(4, 34px);
    }
  }
</style>
