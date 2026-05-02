/* ======================================================================
Copyright 2021 Google LLC
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License. 
========================================================================*/

import { writable } from "svelte/store";

export const connection = writable({
  connected: false,
  deviceName: "",
  version: 0,
  error: "",
});

export const controllerState = writable(0);

export const pose = writable({
  pitch: 0,
  roll: 0,
  yaw: 0,
  flags: 0,
  state: 0,
});

export const calibration = writable({
  active: false,
  completed: false,
  currentStage: 0,
  stable: false,
  progress: 0,
  phase: "idle",
  pendingConfirmation: false,
  lastCapturedPose: null,
});

export const calibrationResults = writable({});
