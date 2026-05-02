import "./scss/main.scss";
import TrainerApp from "./trainer/TrainerApp.svelte";

const app = new TrainerApp({
  target: document.body,
});

export default app;
