<script>
  import { onDestroy, onMount } from "svelte";

  import controllerBle, {
    CalibrationStage,
    ControllerCommand,
    ControllerState,
  } from "../ble/controllerBle";
  import { speakText } from "../audio/voice";
  import {
    mapPoseToControls,
    smoothControls,
  } from "../game/controllerMapping";
  import CalibrationGuide from "./CalibrationGuide.svelte";
  import RacerPanel from "./RacerPanel.svelte";
  import {
    calibration,
    calibrationResults,
    connection,
    controllerState,
    pose,
  } from "../store";

  const stageSequence = [
    {
      id: CalibrationStage.neutral,
      key: "neutral",
      title: "Neutral",
      instruction: "Hold the board level and keep it still.",
    },
    {
      id: CalibrationStage.left,
      key: "left",
      title: "Left",
      instruction: "Lower the left edge of the board.",
    },
    {
      id: CalibrationStage.right,
      key: "right",
      title: "Right",
      instruction: "Lower the right edge of the board.",
    },
    {
      id: CalibrationStage.forward,
      key: "forward",
      title: "Forward",
      instruction: "Lower the USB side of the board.",
    },
    {
      id: CalibrationStage.backward,
      key: "backward",
      title: "Backward",
      instruction: "Lower the rear side of the board.",
    },
  ];

  const calibrationWindowMs = 450;
  const stabilityWindowMs = 700;
  const minStabilitySamples = 8;
  const goodStabilityJitterDeg = 1.4;
  const poorStabilityJitterDeg = 7.0;
  const maxPoseSamples = 80;

  let activeStageIndex = 0;
  let captureInProgress = false;
  let livePoseFrame = 0;
  let panelMode = "calibration";
  let poseSamples = [];
  let motionSamples = [];
  let nanoIntent = createEmptyNanoIntent();
  let smoothedControls = {
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
      forwardDiagonal: false,
    },
  };
  let nanoIntentControls = createControlsFromKeys(nanoIntent.keys, nanoIntent);
  let finalControls = smoothedControls;

  function updateConnection(patch) {
    connection.update((current) => ({ ...current, ...patch }));
  }

  function updateCalibration(patch) {
    calibration.update((current) => ({ ...current, ...patch }));
  }

  function formatAngle(value) {
    return `${value >= 0 ? "+" : ""}${value.toFixed(1)} deg`;
  }

  function formatStd(sample, axis) {
    const value = sample?.stats?.[axis]?.std;
    if (!Number.isFinite(value)) {
      return "-";
    }
    return `${value.toFixed(2)} deg std`;
  }

  function createPoseSample(sourcePose) {
    return {
      time: performance.now(),
      pitch: sourcePose.pitch,
      roll: sourcePose.roll,
      yaw: sourcePose.yaw,
    };
  }

  function normalizeVector(vector) {
    const length = Math.sqrt(
      vector.x * vector.x + vector.y * vector.y + vector.z * vector.z,
    );
    if (!Number.isFinite(length) || length < 0.000001) {
      return { x: 0, y: 0, z: 1 };
    }
    return {
      x: vector.x / length,
      y: vector.y / length,
      z: vector.z / length,
    };
  }

  function createMotionSample(sourceMotion) {
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

  function average(values) {
    if (!values.length) {
      return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function summarizeAxis(samples, axis) {
    const values = samples.map((sample) => sample[axis]);
    const mean = average(values);
    const variance = average(values.map((value) => (value - mean) ** 2));
    return {
      mean,
      min: Math.min(...values),
      max: Math.max(...values),
      std: Math.sqrt(variance),
    };
  }

  function summarizePoseWindow() {
    const now = performance.now();
    const windowSamples = poseSamples.filter(
      (sample) => now - sample.time <= calibrationWindowMs,
    );
    const samples = windowSamples.length ? windowSamples : [createPoseSample($pose)];
    const pitch = summarizeAxis(samples, "pitch");
    const roll = summarizeAxis(samples, "roll");
    const yaw = summarizeAxis(samples, "yaw");
    const motionWindowSamples = motionSamples.filter(
      (sample) => now - sample.time <= calibrationWindowMs,
    );
    const gravitySource = motionWindowSamples.length
      ? motionWindowSamples
      : [{ gravityX: 0, gravityY: 0, gravityZ: 1 }];
    const gravity = normalizeVector({
      x: average(gravitySource.map((sample) => sample.gravityX)),
      y: average(gravitySource.map((sample) => sample.gravityY)),
      z: average(gravitySource.map((sample) => sample.gravityZ)),
    });

    return {
      pitch: pitch.mean,
      roll: roll.mean,
      yaw: yaw.mean,
      gravity,
      stats: {
        pitch,
        roll,
        yaw,
      },
      sampleCount: samples.length,
      windowMs: calibrationWindowMs,
      capturedAt: Date.now(),
    };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function calculatePoseStability() {
    const now = performance.now();
    const samples = poseSamples.filter(
      (sample) => now - sample.time <= stabilityWindowMs,
    );

    if (samples.length < minStabilitySamples) {
      return {
        stable: false,
        progress: 0,
      };
    }

    const pitch = summarizeAxis(samples, "pitch");
    const roll = summarizeAxis(samples, "roll");
    const jitter = Math.max(pitch.std, roll.std);
    const score = clamp(
      ((poorStabilityJitterDeg - jitter) /
        (poorStabilityJitterDeg - goodStabilityJitterDeg)) *
        100,
      0,
      100,
    );

    return {
      stable: score >= 70,
      progress: Math.round(score),
    };
  }

  function updateLocalStability() {
    if (!$calibration.active) {
      return;
    }

    const stability = calculatePoseStability();
    updateCalibration({
      stable: stability.stable,
      progress: stability.progress,
    });
  }

  function rememberPoseSample(nextPose) {
    const sample = createPoseSample(nextPose);
    poseSamples = [...poseSamples, sample].slice(-maxPoseSamples);
    updateLocalStability();
  }

  function rememberMotionSample(nextMotion) {
    motionSamples = [...motionSamples, createMotionSample(nextMotion)].slice(
      -maxPoseSamples,
    );
  }

  function keyCombo(keys) {
    const combo = ["w", "a", "s", "d"]
      .filter((key) => keys?.[key])
      .join("")
      .toUpperCase();

    return combo || "NONE";
  }

  function createEmptyNanoIntent() {
    return {
      label: 0,
      labelName: "NEUTRAL",
      keyMask: 0,
      keys: {
        w: false,
        a: false,
        s: false,
        d: false,
        combo: "NONE",
        forwardDiagonal: false,
      },
      confidence: 0,
      modelReady: false,
      confident: false,
      calibrated: false,
    };
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) {
      return "-";
    }
    return `${Math.round(value * 100)}%`;
  }

  function createControlsFromKeys(keys, intent) {
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
      inputMode: "Nano MLP",
      intent,
    };
  }

  function stateLabel(value) {
    switch (value) {
      case ControllerState.idleConnected:
        return "Connected";
      case ControllerState.calibrating:
        return "Calibrating";
      case ControllerState.ready:
        return "Ready";
      case ControllerState.playing:
        return "Playing";
      case ControllerState.error:
        return "Error";
      case ControllerState.idleDisconnected:
      default:
        return "Disconnected";
    }
  }

  function phaseFromCalibration(stable) {
    if ($calibration.completed) {
      return "completed";
    }
    if ($calibration.phase === "captured") {
      return "captured";
    }
    if (stable) {
      return "stabilizing";
    }
    if ($calibration.active) {
      return "aligning";
    }
    return "idle";
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
    panelMode = "calibration";
    await controllerBle.disconnect();
  }

  async function moveToStage(stage) {
    captureInProgress = false;
    updateCalibration({
      active: true,
      completed: false,
      currentStage: stage.id,
      stable: false,
      progress: 0,
      phase: "aligning",
      pendingConfirmation: false,
      lastCapturedPose: null,
    });
    await controllerBle.setCalibrationStage(stage.id);
  }

  async function startCalibration() {
    panelMode = "calibration";
    poseSamples = [];
    motionSamples = [];
    nanoIntent = createEmptyNanoIntent();
    activeStageIndex = 0;
    captureInProgress = false;
    calibrationResults.set({});
    updateCalibration({
      active: true,
      completed: false,
      currentStage: stageSequence[0].id,
      stable: false,
      progress: 0,
      phase: "aligning",
      pendingConfirmation: false,
      lastCapturedPose: null,
    });
    await controllerBle.sendCommand(ControllerCommand.startCalibration);
    await moveToStage(stageSequence[0]);
    speakText(
      `Start calibration. ${stageSequence[0].title}. ${stageSequence[0].instruction}`,
      { lang: "en-US" },
    );
  }

  async function resetPose() {
    await controllerBle.sendCommand(ControllerCommand.resetPose);
  }

  async function abortCalibration() {
    panelMode = "calibration";
    activeStageIndex = 0;
    captureInProgress = false;
    updateCalibration({
      active: false,
      completed: false,
      currentStage: CalibrationStage.idle,
      stable: false,
      progress: 0,
      phase: "idle",
      pendingConfirmation: false,
      lastCapturedPose: null,
    });
    await controllerBle.sendCommand(ControllerCommand.abortCalibration);
  }

  async function captureCurrentStage() {
    if (
      !$calibration.active ||
      captureInProgress ||
      activeStageIndex >= stageSequence.length
    ) {
      return;
    }

    captureInProgress = true;
    const current = stageSequence[activeStageIndex];
    const snapshot = summarizePoseWindow();

    calibrationResults.update((currentResults) => ({
      ...currentResults,
      [current.key]: snapshot,
    }));
    try {
      await controllerBle.writeCalibrationSample(current.id, snapshot);
    } catch (error) {
      updateConnection({
        error: error?.message || "Calibration sample could not be sent to Nano.",
      });
    }
    updateCalibration({
      phase: "captured",
      pendingConfirmation: false,
      lastCapturedPose: snapshot,
    });

    if (activeStageIndex === stageSequence.length - 1) {
      updateCalibration({
        active: false,
        completed: true,
        currentStage: CalibrationStage.done,
        phase: "completed",
        lastCapturedPose: snapshot,
      });
      controllerState.set(ControllerState.ready);
      captureInProgress = false;
      speakText("Calibration complete.", { lang: "en-US" });
      return;
    }

    activeStageIndex += 1;
    const nextStage = stageSequence[activeStageIndex];
    setTimeout(async () => {
      await moveToStage(nextStage);
      speakText(`Next. ${nextStage.title}. ${nextStage.instruction}`, {
        lang: "en-US",
      });
    }, 420);
  }

  async function enterDriveMode() {
    if ($calibration.active) {
      return;
    }

    panelMode = "drive";
    if ($connection.connected) {
      await controllerBle.sendCommand(ControllerCommand.enterPlaying);
    }
    speakText("Drive mode ready. Nano will output W A S D intent.", {
      lang: "en-US",
    });
  }

  async function returnToCalibration() {
    panelMode = "calibration";
    if ($connection.connected) {
      await controllerBle.sendCommand(ControllerCommand.enterReady);
    }
  }

  $: currentStage =
    $calibration.active || $calibration.completed
      ? stageSequence.find((stage) => stage.id === $calibration.currentStage) ||
        stageSequence[activeStageIndex] ||
        stageSequence[0]
      : null;
  $: currentPhase = phaseFromCalibration($calibration.stable);
  $: rawControls = mapPoseToControls($pose, $calibrationResults);
  $: smoothedControls = smoothControls(smoothedControls, rawControls);
  $: nanoIntentControls = createControlsFromKeys(nanoIntent.keys, nanoIntent);
  $: finalControls =
    panelMode === "drive" && nanoIntent.modelReady
      ? nanoIntentControls
      : smoothedControls;

  onMount(() => {
    let debugPoseTimer = null;

    const handleConnected = (event) => {
      updateConnection({
        connected: true,
        deviceName: event.detail.name,
        version: event.detail.version,
        error: "",
      });
    };

    const handleDisconnected = () => {
      panelMode = "calibration";
      nanoIntent = createEmptyNanoIntent();
      motionSamples = [];
      activeStageIndex = 0;
      captureInProgress = false;
      updateConnection({
        connected: false,
        deviceName: "",
      });
      updateCalibration({
        active: false,
        completed: false,
        currentStage: CalibrationStage.idle,
        stable: false,
        progress: 0,
        phase: "idle",
        pendingConfirmation: false,
        lastCapturedPose: null,
      });
      controllerState.set(ControllerState.idleDisconnected);
    };

    const handleState = (event) => {
      controllerState.set(event.detail);
    };

    const handleIntent = (event) => {
      nanoIntent = event.detail;
    };

    const handlePose = (event) => {
      livePoseFrame += 1;
      rememberPoseSample(event.detail);
      pose.set(event.detail);
      controllerState.set(event.detail.state);
    };

    const handleMotion = (event) => {
      rememberMotionSample(event.detail);
    };

    const handleCalibration = (event) => {
      if (!event.detail.done || !$calibration.active) {
        return;
      }

      updateCalibration({
        active: false,
        completed: true,
        currentStage: CalibrationStage.done,
        stable: true,
        progress: 100,
        phase: "completed",
      });
    };

    controllerBle.addEventListener("connected", handleConnected);
    controllerBle.addEventListener("disconnected", handleDisconnected);
    controllerBle.addEventListener("state", handleState);
    controllerBle.addEventListener("pose", handlePose);
    controllerBle.addEventListener("motion", handleMotion);
    controllerBle.addEventListener("calibration", handleCalibration);
    controllerBle.addEventListener("intent", handleIntent);

    if (new URLSearchParams(window.location.search).get("debugPose") === "1") {
      let demoTime = 0;
      debugPoseTimer = window.setInterval(() => {
        demoTime += 0.08;
        const demoPose = {
          pitch: Math.sin(demoTime) * 34,
          roll: Math.cos(demoTime * 0.8) * 30,
          yaw: Math.sin(demoTime * 0.35) * 90,
          flags: 0,
          state: ControllerState.idleConnected,
        };

        livePoseFrame += 1;
        rememberPoseSample(demoPose);
        pose.set(demoPose);
        rememberMotionSample({
          gravityX: Math.sin(demoTime) * 0.4,
          gravityY: Math.cos(demoTime * 0.8) * 0.35,
          gravityZ: 0.84,
          gyroX: Math.cos(demoTime) * 16,
          gyroY: Math.sin(demoTime * 0.7) * 12,
          gyroZ: Math.cos(demoTime * 0.4) * 8,
        });
      }, 50);
    }

    return () => {
      if (debugPoseTimer) {
        window.clearInterval(debugPoseTimer);
      }
      controllerBle.removeEventListener("connected", handleConnected);
      controllerBle.removeEventListener("disconnected", handleDisconnected);
      controllerBle.removeEventListener("state", handleState);
      controllerBle.removeEventListener("pose", handlePose);
      controllerBle.removeEventListener("motion", handleMotion);
      controllerBle.removeEventListener("calibration", handleCalibration);
      controllerBle.removeEventListener("intent", handleIntent);
    };
  });

  onDestroy(() => {
    if ($connection.connected) {
      controllerBle.disconnect();
    }
  });
</script>

<section class="panel controller-panel">
  <div class="container">
    <div class="hero">
      <div>
        <p class="eyebrow">IMU Racer Controller</p>
        <h1>{panelMode === "drive" ? "Drive Control Lab" : "Pose Calibration Desk"}</h1>
        <p class="summary">
          {#if panelMode === "drive"}
            Drive mode now accepts both calibrated IMU input and physical WASD
            keys. Use keyboard first to feel the game, then compare it with the
            board control.
          {:else}
            This page verifies BLE, pose streaming, and a confirmation-based
            calibration flow before the racing controls are connected.
          {/if}
        </p>
      </div>
      <div class="actions">
        {#if !$connection.connected}
          <button on:click={connect}>Connect Controller</button>
        {:else}
          <button on:click={disconnect}>Disconnect</button>
        {/if}
        <button on:click={startCalibration} disabled={!$connection.connected}>
          Start Calibration
        </button>
        <button on:click={resetPose} disabled={!$connection.connected}>
          Reset Pose
        </button>
        <button
          on:click={abortCalibration}
          disabled={!$connection.connected || !$calibration.active}
        >
          Abort Calibration
        </button>
        <button
          on:click={enterDriveMode}
          disabled={$calibration.active}
        >
          Enter Drive Mode
        </button>
        <button on:click={returnToCalibration} disabled={panelMode !== "drive"}>
          Back to Calibration
        </button>
      </div>
    </div>

    <div class="status-grid">
      <article class="card">
        <h2>Connection</h2>
        <p>Device: {$connection.deviceName || "Not connected"}</p>
        <p>Firmware: {$connection.version || "-"}</p>
        <p>State: {stateLabel($controllerState)}</p>
        {#if $connection.error}
          <p class="error">Error: {$connection.error}</p>
        {/if}
      </article>

      <article class="card">
        <h2>{panelMode === "drive" ? "Live Controls" : "Live Pose"}</h2>
        <div class="pose-grid">
          <div>
            <span>{panelMode === "drive" ? "Steer" : "Pitch"}</span>
            <strong>
              {panelMode === "drive"
                ? finalControls.steer.toFixed(2)
                : formatAngle($pose.pitch)}
            </strong>
          </div>
          <div>
            <span>{panelMode === "drive" ? "Throttle" : "Roll"}</span>
            <strong>
              {panelMode === "drive"
                ? finalControls.throttle.toFixed(2)
                : formatAngle($pose.roll)}
            </strong>
          </div>
          <div>
            <span>{panelMode === "drive" ? "Reverse" : "Yaw"}</span>
            <strong>
              {panelMode === "drive"
                ? finalControls.reverse.toFixed(2)
                : formatAngle($pose.yaw)}
            </strong>
          </div>
        </div>
      </article>

      <article class="card">
        <h2>Nano Intent</h2>
        <p>Prediction: {nanoIntent.labelName} ({formatPercent(nanoIntent.confidence)})</p>
        <p>Output: {nanoIntent.keys?.combo || "NONE"}</p>
        <p>Source: {nanoIntent.modelReady ? "Nano MLP firmware" : "Rule fallback"}</p>
        <p>Calibration: {nanoIntent.calibrated ? "Written to Nano" : "Waiting for five captures"}</p>
        <p class="hint-text">
          Final ML inference runs on the Nano. The browser only displays the
          intent packet and falls back to rule control if the firmware has not
          been updated yet.
        </p>
      </article>
    </div>

    {#if panelMode === "drive"}
      <RacerPanel
        controls={finalControls}
        pose={$pose}
        calibrationResults={$calibrationResults}
        on:back={returnToCalibration}
      />
    {:else}
      <div class="guide-layout">
        <CalibrationGuide
          stage={currentStage}
          progress={$calibration.progress}
          phase={currentPhase}
          pose={$pose}
        />
        <article class="card help-card">
          <h2>Capture flow</h2>
          <p>1. Move the board into the shown direction.</p>
          <p>2. Ignore small pose jitter while holding it by hand.</p>
          <p>3. Press the button when the board looks correct.</p>
          <p>4. The captured angle freezes and the next step starts.</p>
          <button
            class="confirm-button"
            on:click={captureCurrentStage}
            disabled={!$calibration.active || captureInProgress}
          >
            {captureInProgress ? "Capturing..." : "Confirm Capture"}
          </button>
          <p class="hint-text">
            The progress bar shows live stability only, not whether the angle
            reached a fixed threshold. Capture is fully manual. A future voice
            or ML module can trigger the same capture hook.
          </p>
        </article>
      </div>

      <div class="result-grid">
        {#each stageSequence as stage}
          <article class="result-card">
            <h3>{stage.title}</h3>
            {#if $calibrationResults[stage.key]}
              <p>Pitch: {formatAngle($calibrationResults[stage.key].pitch)}</p>
              <p>Roll: {formatAngle($calibrationResults[stage.key].roll)}</p>
              <p>Samples: {$calibrationResults[stage.key].sampleCount || 1}</p>
              <p>Pitch jitter: {formatStd($calibrationResults[stage.key], "pitch")}</p>
              <p>Roll jitter: {formatStd($calibrationResults[stage.key], "roll")}</p>
            {:else}
              <p>Not captured yet</p>
            {/if}
          </article>
        {/each}
      </div>
    {/if}
  </div>
</section>

<style lang="scss">
  .controller-panel {
    min-height: 100vh;
    background:
      radial-gradient(circle at top left, rgba(255, 187, 92, 0.15), transparent 28%),
      linear-gradient(135deg, #0f1a24, #142636 52%, #1a3443);
  }

  .container {
    width: min(1180px, calc(100vw - 48px));
    padding: 48px 0;
  }

  .hero {
    display: grid;
    grid-template-columns: 1.6fr 1fr;
    gap: 24px;
    align-items: start;
  }

  .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: #ffbb5c;
    margin-bottom: 12px;
  }

  h1 {
    font-size: clamp(52px, 8vw, 84px);
    line-height: 0.9;
    margin-bottom: 20px;
  }

  .summary {
    max-width: 740px;
    color: rgba(255, 255, 255, 0.76);
  }

  .actions {
    display: grid;
    gap: 12px;
    justify-items: stretch;
  }

  .actions button[disabled],
  .confirm-button[disabled] {
    opacity: 0.45;
  }

  .status-grid,
  .guide-layout,
  .result-grid {
    display: grid;
    gap: 18px;
    margin-top: 28px;
  }

  .status-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .result-grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .guide-layout {
    grid-template-columns: 1.2fr 0.8fr;
  }

  .card,
  .result-card {
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(8, 14, 19, 0.38);
    backdrop-filter: blur(10px);
    border-radius: 18px;
    padding: 20px;
  }

  .card h2,
  .result-card h3 {
    margin: 0 0 14px;
  }

  .pose-grid {
    display: grid;
    gap: 18px;
  }

  .pose-grid div {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    padding-bottom: 10px;
  }

  .pose-grid span {
    color: rgba(255, 255, 255, 0.6);
  }

  .pose-grid strong {
    font-size: 28px;
  }

  .confirm-button {
    margin-top: 8px;
  }

  .hint-text {
    margin-top: 14px;
    color: rgba(255, 255, 255, 0.62);
  }

  .error {
    color: #ff8d8d;
  }

  @media (max-width: 960px) {
    .hero,
    .status-grid,
    .guide-layout,
    .result-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
