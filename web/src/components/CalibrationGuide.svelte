<script>
  export let stage;
  export let progress = 0;
  export let phase = "idle";
  export let pose = { pitch: 0, roll: 0, yaw: 0 };

  function getGuide() {
    switch (stage?.key) {
      case "left":
        return {
          hint: "LEFT EDGE DOWN",
          caption: "Lower the LEFT EDGE label while keeping the USB side forward.",
          boardClass: "tilt-left-edge-down",
          activeEdge: "left",
          edgeLabel: "Lower left edge",
        };
      case "right":
        return {
          hint: "RIGHT EDGE DOWN",
          caption: "Lower the RIGHT EDGE label while keeping the USB side forward.",
          boardClass: "tilt-right-edge-down",
          activeEdge: "right",
          edgeLabel: "Lower right edge",
        };
      case "forward":
        return {
          hint: "USB SIDE DOWN",
          caption: "Lower the USB / FRONT side shown on the left of the real board image.",
          boardClass: "tilt-usb-down",
          activeEdge: "usb",
          edgeLabel: "Lower USB side",
        };
      case "backward":
        return {
          hint: "REAR SIDE DOWN",
          caption: "Lower the REAR side opposite the USB connector.",
          boardClass: "tilt-rear-down",
          activeEdge: "rear",
          edgeLabel: "Lower rear side",
        };
      case "neutral":
      default:
        return {
          hint: "KEEP LEVEL",
          caption: "Hold the board flat with the USB side forward.",
          boardClass: "tilt-neutral",
          activeEdge: "level",
          edgeLabel: "Keep board level",
        };
    }
  }

  function getStatusLabel() {
    switch (phase) {
      case "aligning":
        return "Unstable";
      case "stabilizing":
        return "Stable";
      case "pending_confirmation":
        return "Waiting for confirmation";
      case "captured":
        return "Angle captured";
      case "completed":
        return "Calibration complete";
      default:
        return "Idle";
    }
  }

  function formatAngle(value) {
    return `${value >= 0 ? "+" : ""}${value.toFixed(1)} deg`;
  }

  $: guide = getGuide();
  $: statusLabel = getStatusLabel();
</script>

<div class="guide-card">
  <div class="card-head">
    <div class="stage-tag">{stage?.title || "Calibration"}</div>
    <div class={`phase phase-${phase}`}>{statusLabel}</div>
  </div>

  <div class={`scene active-${guide.activeEdge}`}>
    <div class="board-photo" aria-label={guide.caption}>
      <img
        src="/images/nano33_ble_sense.png"
        alt="Arduino Nano 33 BLE Sense board"
      />
      <div class="edge-label label-usb">USB / FRONT</div>
      <div class="edge-label label-rear">REAR</div>
      <div class="edge-label label-left">LEFT EDGE</div>
      <div class="edge-label label-right">RIGHT EDGE</div>
      {#if guide.activeEdge !== "level"}
        <div class={`down-marker marker-${guide.activeEdge}`}>DOWN</div>
      {/if}
    </div>
    <div class="hint">{guide.hint}</div>
  </div>

  <p class="caption">{guide.caption}</p>

  <div class="progress-head">
    <span>Live stability</span>
    <strong>{Math.round(progress)}%</strong>
  </div>
  <div class="progress-shell">
    <div class="progress-bar" style={`width:${Math.max(4, progress)}%`} />
  </div>

  <div class="pose-row">
    <span>Pitch {formatAngle(pose.pitch)}</span>
    <span>Roll {formatAngle(pose.roll)}</span>
    <span>Yaw {formatAngle(pose.yaw)}</span>
  </div>
</div>

<style lang="scss">
  .guide-card {
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(8, 14, 19, 0.38);
    backdrop-filter: blur(10px);
    border-radius: 18px;
    padding: 20px;
    min-height: 320px;
  }

  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 16px;
  }

  .stage-tag,
  .phase {
    display: inline-flex;
    align-items: center;
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 14px;
  }

  .stage-tag {
    background: rgba(255, 187, 92, 0.12);
    color: #ffbb5c;
  }

  .phase {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.78);
  }

  .phase-pending_confirmation {
    background: rgba(122, 229, 130, 0.16);
    color: #7ae582;
  }

  .phase-captured,
  .phase-completed {
    background: rgba(122, 229, 130, 0.16);
    color: #7ae582;
  }

  .scene {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 310px;
    background:
      radial-gradient(circle at 50% 46%, rgba(122, 229, 130, 0.12), transparent 24%),
      radial-gradient(circle at center, rgba(255, 255, 255, 0.06), transparent 58%),
      linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0));
    border-radius: 16px;
    overflow: hidden;
    isolation: isolate;
  }

  .board-photo {
    position: relative;
    width: min(96%, 560px);
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 22px 40px rgba(0, 0, 0, 0.34);
  }

  .board-photo img {
    display: block;
    width: 100%;
    user-select: none;
    pointer-events: none;
  }

  .edge-label,
  .down-marker {
    position: absolute;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    font-weight: 800;
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.24);
  }

  .edge-label {
    padding: 6px 10px;
    border: 1px solid rgba(255, 255, 255, 0.24);
    background: rgba(7, 12, 16, 0.72);
    color: rgba(255, 255, 255, 0.86);
    font-size: 12px;
  }

  .label-usb {
    left: 10%;
    bottom: 24%;
  }

  .label-rear {
    right: 10%;
    top: 23%;
  }

  .label-left {
    right: 30%;
    bottom: 15%;
  }

  .label-right {
    left: 38%;
    top: 18%;
  }

  .active-left .label-left,
  .active-right .label-right,
  .active-usb .label-usb,
  .active-rear .label-rear {
    border-color: rgba(255, 187, 92, 0.9);
    background: rgba(255, 187, 92, 0.22);
    color: #ffcf8a;
  }

  .down-marker {
    padding: 7px 12px;
    background: #ffbb5c;
    color: #120e08;
    font-size: 12px;
  }

  .down-marker::before {
    content: "";
    width: 0;
    height: 0;
    margin-right: 7px;
    border-left: 5px solid transparent;
    border-right: 5px solid transparent;
    border-top: 9px solid currentColor;
  }

  .marker-usb {
    left: 13%;
    bottom: 36%;
  }

  .marker-rear {
    right: 12%;
    top: 35%;
  }

  .marker-left {
    right: 32%;
    bottom: 27%;
  }

  .marker-right {
    left: 40%;
    top: 30%;
  }

  .hint {
    position: absolute;
    bottom: 18px;
    padding: 8px 12px;
    border-radius: 999px;
    background: rgba(255, 187, 92, 0.14);
    color: #ffbb5c;
    font-size: 14px;
    letter-spacing: 0.1em;
    z-index: 2;
  }

  .caption {
    margin: 16px 0 14px;
    color: rgba(255, 255, 255, 0.74);
  }

  .progress-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    color: rgba(255, 255, 255, 0.68);
    font-size: 13px;
    letter-spacing: 0.04em;
  }

  .progress-head strong {
    color: #ffbb5c;
    font-size: 14px;
  }

  .progress-shell {
    height: 14px;
    border-radius: 999px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.08);
    margin-bottom: 14px;
  }

  .progress-bar {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #ffbb5c, #7ae582);
    transition: width 120ms linear;
  }

  .pose-row {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    color: rgba(255, 255, 255, 0.72);
    font-size: 14px;
  }
</style>
